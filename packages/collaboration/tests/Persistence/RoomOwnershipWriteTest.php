<?php

declare(strict_types=1);

use Illuminate\Support\Str;
use Vaulter\Collaboration\Persistence\RoomWriteConflict;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\RoomOwnership;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CollaborativeState;

it('refuses legacy, stale-fence and stale-base appends to a strict generation', function (): void {
    Hub::configure();
    $node = Hub::document();
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
    $aggregate = Hub::aggregate($node);
    $seed = new UpdateEnvelope($aggregate->collab_epoch, (string) Str::uuid(), 'seed', hash('sha256', 'seed'), 'server', $aggregate->state_version);
    $log = app(UpdateLog::class);

    expect(fn () => $log->append($nodeId, $seed))->toThrow(RoomWriteConflict::class, 'strict_profile_required')
        ->and(fn () => $log->appendFenced($nodeId, $seed, $owner, 2, 0, static fn (): null => null))->toThrow(RoomWriteConflict::class, 'stale_owner')
        ->and(fn () => $log->appendFenced($nodeId, $seed, $owner, 1, 1, static fn (): null => null))->toThrow(RoomWriteConflict::class, 'base_moved')
        ->and($log->snapshot($nodeId, $aggregate->collab_epoch)->headSeq)->toBe(0)
        ->and($log->appendFenced($nodeId, $seed, $owner, 1, 0, static fn (): null => null)->seq)->toBe(1)
        ->and($log->appendFenced($nodeId, $seed, $owner, 1, 0, static fn (): null => null)->duplicate)->toBeTrue();
});
