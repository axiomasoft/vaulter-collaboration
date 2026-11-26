<?php

declare(strict_types=1);

use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Str;
use Vaulter\Collaboration\Exceptions\CollaborationCheckpointConflictException;
use Vaulter\Collaboration\Persistence\CheckpointResult;
use Vaulter\Collaboration\Persistence\CompactionLeases;
use Vaulter\Collaboration\Persistence\LogTables;
use Vaulter\Collaboration\Persistence\RetiredGenerations;
use Vaulter\Collaboration\Persistence\RoomWriteConflict;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\RoomOwnership;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CollaborationStateBinding;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Drive\Models\Node;

function strictOwnerOf(Node $node): string
{
    $db = app(VaulterDatabase::class);
    $db->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $nodeId = $node->getKey();
    $owner = (string) Str::uuid();
    $db->transaction(function () use ($nodeId, $owner): void {
        $locked = app(CollaborativeState::class)->lock($nodeId);
        $rooms = app(RoomOwnership::class);
        $rooms->selectProfile($locked, strict: true);
        expect($rooms->acquire($locked, $owner)->ownerFence)->toBe(1);
    });

    return $owner;
}

it('refuses unfenced appends and returns the current prefix to the strict owner with a stale base', function (): void {
    Hub::configure();
    $node = Hub::document();
    $owner = strictOwnerOf($node);
    $nodeId = $node->getKey();
    $aggregate = Hub::aggregate($node);
    $seed = new UpdateEnvelope($aggregate->collab_epoch, (string) Str::uuid(), 'seed', hash('sha256', 'seed'), 'server', $aggregate->state_version);
    $log = app(UpdateLog::class);

    expect(fn () => $log->append($nodeId, $seed))->toThrow(RoomWriteConflict::class, 'strict_profile_required')
        ->and(fn () => $log->appendFenced($nodeId, $seed, $owner, 2, 0, static fn (): null => null))->toThrow(RoomWriteConflict::class, 'stale_owner')
        ->and(fn () => $log->appendFenced($nodeId, $seed, $owner, 1, 1, static fn (): null => null))->toThrow(RoomWriteConflict::class, 'base_moved')
        ->and($log->snapshot($nodeId, $aggregate->collab_epoch)->headSeq)->toBe(0)
        ->and($log->appendFenced($nodeId, $seed, $owner, 1, 0, static fn (): null => null)->seq)->toBe(1)
        ->and($log->appendFenced($nodeId, $seed, $owner, 1, 0, static fn (): null => null)->duplicate)->toBeTrue();

    $migration = require __DIR__.'/../../database/migrations/0001_01_01_000509_track_collaboration_tails.php';
    $migration->down();
    $migration->up();
    expect(Compaction::head($node)?->tailBytes)->toBe(4)
        ->and(Compaction::head($node)?->tailWireBytes)->toBe(8);

    $bytes = "\x00\xff\x5cA";
    $next = new UpdateEnvelope($aggregate->collab_epoch, (string) Str::uuid(), $bytes, hash('sha256', $bytes), 'server');
    Hub::callV2('append', Hub::appendBody($node, $bytes, origin: 'server') + [
        'owner_id' => $owner, 'owner_fence' => 1, 'base_seq' => 0,
    ], token: Hub::token($node))
        ->assertStatus(409)
        ->assertJsonPath('meta.context.reason', 'base_moved')
        ->assertJsonPath('meta.context.replay.head_seq', 1)
        ->assertJsonPath('meta.context.replay.tail', [
            ['seq' => 1, 'update_id' => $seed->updateId, 'payload' => base64_encode('seed'), 'sha256' => $seed->sha256()],
        ]);

    expect($log->appendFenced($nodeId, $next, $owner, 1, 1, static fn (): null => null)->seq)->toBe(2)
        ->and(array_column($log->snapshot($nodeId, $aggregate->collab_epoch)->tail, 'payload'))->toBe([
            base64_encode('seed'), base64_encode($bytes),
        ]);
    if (app(VaulterDatabase::class)->driver() === 'pgsql') {
        $stored = app(LogTables::class)->rows('collaboration_updates', (string) $aggregate->getKey(), $aggregate->collab_epoch)
            ->where('seq', 2)->first(['payload', 'payload_raw']);
        expect($stored?->payload_raw)->toBeTrue()
            ->and(is_resource($stored?->payload) ? stream_get_contents($stored->payload) : $stored?->payload)->toBe($bytes);
    }

    $tailReads = 0;
    app(VaulterDatabase::class)->connection()->listen(static function (QueryExecuted $query) use (&$tailReads): void {
        if (str_starts_with($query->sql, 'select') && str_contains($query->sql, 'collaboration_updates')) {
            $tailReads++;
        }
    });
    expect(Compaction::lease())->toBe([])
        ->and($tailReads)->toBe(0);
});

it('publishes a strict V2 checkpoint while preserving later writes and V1 room tokens', function (): void {
    Hub::configure();
    $node = Hub::document();
    $owner = strictOwnerOf($node);
    $aggregate = Hub::aggregate($node);
    $oldToken = Hub::token($node);
    $append = function (string $bytes, int $base) use ($node, $owner, $aggregate): int {
        $update = new UpdateEnvelope(
            $aggregate->collab_epoch, (string) Str::uuid(), $bytes, hash('sha256', $bytes), 'server',
            $base === 0 ? $aggregate->state_version : null,
        );

        return app(UpdateLog::class)->appendFenced($node->getKey(), $update, $owner, 1, $base, static fn (): null => null)->seq;
    };
    $drain = function () use ($node): void {
        $marker = app(VaulterDatabase::class)->transaction(fn () => app(CollaborativeState::class)->lock($node->getKey())->pending);
        expect($marker)->not->toBeNull();
        app(CompactionLeases::class)->requestDrain($marker);
    };

    $append('seed', 0);
    $drain();
    $v1 = Compaction::leaseOf($node);
    Compaction::publish($v1);
    $append('compact this', 1);
    $drain();
    $lease = Compaction::leaseOf($node);
    $append("\x00\xff", 2);
    $format = new CollaborationStateBinding('yjs', 'yjs-update-v2', $lease->log->schemaVersion, $lease->log->generation);
    $result = Compaction::publish($lease, overrides: ['binding' => $format, 'state' => "\x00v2"]);

    $document = Hub::aggregate($node);
    $head = Compaction::head($node);
    expect($result->markerCleared)->toBeFalse()
        ->and($document->collaborationBinding()?->sameAs($format))->toBeTrue()
        ->and($document->syncState?->pending_state_format)->toBe('yjs-update-v2')
        ->and($head?->tailBytes)->toBe(2)
        ->and($head?->tailWireBytes)->toBe(4)
        ->and($head?->tailOldestAt)->not->toBeNull()
        ->and(Compaction::seqs($node))->toBe([3]);
    Hub::callV2('load', ['room' => Hub::room($node)], token: $oldToken)->assertOk()
        ->assertJsonPath('state_format', 'yjs-update-v2')
        ->assertJsonPath('checkpoint', base64_encode("\x00v2"));
    Hub::callV2('append', Hub::appendBody($node, 'retry', origin: 'server') + [
        'owner_id' => $owner, 'owner_fence' => 1, 'base_seq' => 1,
    ], token: $oldToken)->assertStatus(409)
        ->assertJsonPath('meta.context.replay.checkpoint_seq', 2)
        ->assertJsonPath('meta.context.replay.checkpoint', base64_encode("\x00v2"))
        ->assertJsonPath('meta.context.replay.tail.0.seq', 3);

    $append('later', 3);
    $last = Compaction::leaseOf($node);
    expect(fn (): CheckpointResult => Compaction::publish($last, overrides: ['binding' => $v1->log->binding]))
        ->toThrow(CollaborationCheckpointConflictException::class)
        ->and(Compaction::publish($last)->markerCleared)->toBeTrue()
        ->and(Compaction::head($node)?->tailBytes)->toBe(0)
        ->and(Compaction::head($node)?->tailOldestAt)->toBeNull();
});

it('prunes client reservations only when their generation has retired past the cutoff', function (): void {
    Hub::configure();
    $node = Hub::document();
    Compaction::append($node, 'seed');
    $document = Hub::aggregate($node);
    $tables = app(LogTables::class);
    $id = (string) $document->getKey();
    $db = app(VaulterDatabase::class);
    $now = now();
    $db->write(function () use ($tables, $id, $document, $now): void {
        $tables->rows('collaboration_heads', $id, $document->collab_epoch)->update(['retired_at' => $now]);
        $document->forceFill(['collab_epoch' => $document->collab_epoch + 1])->save();
        foreach ([$document->collab_epoch - 1, $document->collab_epoch] as $generation) {
            $tables->table('collaboration_client_ids')->insert([
                'document_id' => $document->getKey(), 'generation' => $generation,
                'client_id' => 7, 'tenant_id' => 1, 'writer_kind' => 'historical',
            ]);
        }
    });

    $retired = app(RetiredGenerations::class);
    expect($retired->prune($now->copy()->subSecond())['generations'])->toBe(0)
        ->and($tables->rows('collaboration_client_ids', $id, $document->collab_epoch - 1)->count())->toBe(1)
        ->and($retired->prune($now->copy()->addSecond())['generations'])->toBe(1)
        ->and($tables->rows('collaboration_client_ids', $id, $document->collab_epoch - 1)->count())->toBe(0)
        ->and($tables->rows('collaboration_client_ids', $id, $document->collab_epoch)->count())->toBe(1);
});
