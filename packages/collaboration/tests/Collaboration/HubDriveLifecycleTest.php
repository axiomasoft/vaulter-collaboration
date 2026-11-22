<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Vaulter\Collaboration\CollaborationCall;
use Vaulter\Collaboration\CollaborationHub;
use Vaulter\Collaboration\Data\RoomRef;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Revocation\PermissionVersion;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Documents\Events\Documents\DocumentContentUpdated;
use Vaulter\Drive\Actions\Drives\ArchiveDriveAction;
use Vaulter\Drive\Actions\Drives\DeleteDriveAction;
use Vaulter\Drive\Enums\DriveStatus;
use Vaulter\Drive\Exceptions\Access\PermissionDeniedException;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Testing\Fixtures\TestUser;
use Vaulter\ValueObjects\Access\ActorRef;

/*
 * An archive or a deletion of the drive committed after the hub opened a room still refuses the room's next append: the
 * log reads the drive's status under the drive lock its append takes, so no record lands after either.
 */
it('refuses an append when the drive changes after the room was opened', function (DriveStatus $status, string $exception): void {
    Hub::configure();
    Queue::fake();
    $node = Hub::document();
    $call = new CollaborationCall(
        room: Hub::room($node),
        ref: new RoomRef(driveId: (string) $node->drive_id, nodeId: (string) $node->id, epoch: 0),
        principal: new ActorRef((new TestUser)->getMorphClass(), '1'),
        protocol: 'yjs',
        stateFormat: 'yjs-update-v1', mode: 'rw', schemaVersion: 1, tenant: null,
        permissionsVersion: new PermissionVersion(drive: 0, global: 0), jti: 'test-call', expiresAt: time() + 300,
    );
    $hub = app(CollaborationHub::class);
    $room = $hub->open($call, $call->room);
    expect($room->driveActive)->toBeTrue();

    $action = $status === DriveStatus::Archived ? ArchiveDriveAction::class : DeleteDriveAction::class;
    app($action)->execute(DocumentTestHelpers::context($node));
    $before = Hub::aggregate($node)->getAttributes();
    $history = DocumentTestHelpers::revisions($node)->modelKeys();
    $sequence = $node->fresh()->sequence;
    Event::fake([DocumentContentUpdated::class]);

    expect(fn () => $hub->append($room, $call, new UpdateEnvelope(
        generation: 0, updateId: (string) Str::uuid(), payload: 'late-update', claimedSha256: hash('sha256', 'late-update'),
    )))->toThrow($exception)
        ->and(Hub::aggregate($node)->getAttributes())->toBe($before)
        ->and(Compaction::head($node))->toBeNull()
        ->and(DocumentTestHelpers::revisions($node)->modelKeys())->toBe($history)
        ->and($node->fresh()->sequence)->toBe($sequence);
    Event::assertNotDispatched(DocumentContentUpdated::class);
})->with([
    'archived' => [DriveStatus::Archived, PermissionDeniedException::class],
    'deleting' => [DriveStatus::Deleting, NodeNotFoundException::class],
]);
