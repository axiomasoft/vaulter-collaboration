<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Vaulter\Collaboration\Exceptions\CollaborationUpdateMismatchException;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Drive\Models\Node;

/*
 * Scenario 1: an update id is committed once. The first append gets seq 1, its receipt and the pending marker;
 * a retry after a lost answer gets the same seq from the receipt and writes nothing (no second row, no event, no move
 * of the marker); the same id with another payload, or a hash that is not the payload's, is refused untouched.
 */

function idemAppend(Node $node, string $payload, string $updateId, ?string $sha256 = null): mixed
{
    // The first record of an empty, unseeded generation is its seed (server origin, CAS on the state version).
    $aggregate = Hub::aggregate($node);
    $seed = $aggregate->collab_state_size === null && (Compaction::head($node)?->headSeq ?? 0) === 0;

    return app(UpdateLog::class)->append($node->getKey(), new UpdateEnvelope(
        generation: $aggregate->collab_epoch,
        updateId: $updateId,
        payload: $payload,
        claimedSha256: $sha256 ?? hash('sha256', $payload),
        origin: $seed ? 'server' : 'client',
        seedStateVersion: $seed ? $aggregate->state_version : null,
    ));
}

function idemCount(string $entity): int
{
    return DB::table(app(DatabaseOptions::class)->table($entity))->count();
}

beforeEach(function (): void {
    Hub::configure();
    $this->node = Hub::document();
    $this->id = (string) Str::uuid();
});

it('commits the first append as seq 1 with its receipt, head and pending marker', function (): void {
    $result = idemAppend($this->node, "\x01\x00yjs", $this->id);
    $document = Hub::aggregate($this->node);
    $update = DB::table(app(DatabaseOptions::class)->table('collaboration_updates'))->first();
    $storedPayload = is_resource($update->payload) ? stream_get_contents($update->payload) : $update->payload;
    if ($storedPayload === false) {
        throw new RuntimeException('Unable to read stored update bytes.');
    }

    expect($result->ack())->toBe(['generation' => 0, 'update_id' => $this->id, 'seq' => 1, 'sha256' => hash('sha256', "\x01\x00yjs"), 'persisted' => true])
        ->and($result->duplicate)->toBeFalse()
        ->and(idemCount('collaboration_updates'))->toBe(1)
        ->and(idemCount('collaboration_receipts'))->toBe(1)
        ->and(DB::table(app(DatabaseOptions::class)->table('collaboration_heads'))->value('head_seq'))->toBe(1)
        ->and(base64_decode($storedPayload, true))->toBe("\x01\x00yjs")
        ->and([$document->pending_generation, $document->pending_through_seq])->toBe([0, 1]);
});

it('answers a retried update id from its receipt without a second row, an event or a moved marker', function (): void {
    idemAppend($this->node, 'update-a', $this->id);
    idemAppend($this->node, 'update-b', (string) Str::uuid());
    $before = Hub::aggregate($this->node);

    $events = [];
    Event::listen('*', static function (string $name) use (&$events): void {
        if (str_starts_with($name, 'Vaulter\\')) {
            $events[] = $name;
        }
    });
    $outbox = idemCount('outbox');
    $retry = idemAppend($this->node, 'update-a', $this->id);

    $after = Hub::aggregate($this->node);
    expect($events)->toBe([])
        ->and(idemCount('outbox'))->toBe($outbox)
        ->and($retry->seq)->toBe(1)
        ->and($retry->duplicate)->toBeTrue()
        ->and($retry->ack()['persisted'])->toBeTrue()
        ->and(idemCount('collaboration_updates'))->toBe(2)
        ->and(idemCount('collaboration_receipts'))->toBe(2)
        ->and([$after->pending_generation, $after->pending_through_seq])->toBe([0, 2])
        ->and($after->state_version)->toBe($before->state_version);
});

it('refuses the same update id with another payload and writes nothing', function (): void {
    idemAppend($this->node, 'update-a', $this->id);

    expect(fn (): mixed => idemAppend($this->node, 'update-other', $this->id))->toThrow(CollaborationUpdateMismatchException::class)
        ->and(idemCount('collaboration_updates'))->toBe(1)
        ->and(Hub::aggregate($this->node)->pending_through_seq)->toBe(1);
});

it('refuses a hash that is not the payload\'s before anything is locked or written', function (): void {
    expect(fn (): mixed => idemAppend($this->node, 'update-a', $this->id, sha256: hash('sha256', 'something else')))->toThrow(CollaborationUpdateMismatchException::class)
        ->and(idemCount('collaboration_updates'))->toBe(0)
        ->and(idemCount('collaboration_receipts'))->toBe(0)
        ->and(idemCount('collaboration_heads'))->toBe(0)
        ->and(Hub::aggregate($this->node)->pending_generation)->toBeNull();
});

it('numbers the updates of a generation one after the other and moves the marker with the head', function (): void {
    $seqs = array_map(fn (string $payload): int => idemAppend($this->node, $payload, (string) Str::uuid())->seq, ['one', 'two', 'three']);

    expect($seqs)->toBe([1, 2, 3])
        ->and(Hub::aggregate($this->node)->pending_through_seq)->toBe(3)
        ->and(DB::table(app(DatabaseOptions::class)->table('collaboration_heads'))->value('head_seq'))->toBe(3);
});
