<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Concurrency\RaceFixtures;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Drive\Actions\Drives\ArchiveDriveAction;
use Vaulter\Drive\Actions\Drives\DeleteDriveAction;
use Vaulter\Drive\Actions\Trash\TrashNodeAction;
use Vaulter\Drive\Data\Trash\TrashNodeInput;
use Vaulter\Drive\Enums\DriveStatus;
use Vaulter\Drive\Models\Node;
use Vaulter\Testing\Concurrency\ForkRace;

/**
 * Liveness on real backends, for the collaboration log: a hub append racing a trash, an archive or a deletion of
 * the node/drive either lands entirely before it or is refused after it (the log reads the trash flag and the drive's
 * status under the locks its append takes), with state, log and events matching the outcome. Two forked processes on
 * two PostgreSQL connections, released together by the barrier.
 */
beforeEach(function (): void {
    ForkRace::skipUnlessSupported($this, app(VaulterDatabase::class)->connection()->getName());
    config()->set('vaulter-documents.revisions.checkpoint_interval_seconds', 0);
});

/** The hub's first record of the empty generation, so its seed, built from the JSON of `$stateVersion`. */
function hubAppend(Node $node, int $stateVersion): mixed
{
    return app(UpdateLog::class)->append($node->getKey(), new UpdateEnvelope(
        generation: 0, updateId: (string) Str::uuid(), payload: 'raced-update', claimedSha256: hash('sha256', 'raced-update'),
        origin: 'server', seedStateVersion: $stateVersion,
    ));
}

it('a hub append racing a trash lands before it or is refused after it, never after', function (): void {
    $node = RaceFixtures::document();
    $nodeId = $node->getKey();
    $before = [DocumentTestHelpers::document($node)->state_version, DocumentTestHelpers::revisions($node)->count()];

    $results = RaceFixtures::race([
        static fn (): array => RaceFixtures::attempt(static fn () => app(TrashNodeAction::class)->execute(
            DocumentTestHelpers::context(Node::query()->findOrFail($nodeId)), new TrashNodeInput(Node::query()->findOrFail($nodeId)),
        )),
        static fn (): array => RaceFixtures::attempt(static fn (): mixed => hubAppend(Node::query()->findOrFail($nodeId), $before[0])),
    ]);

    $fresh = Node::query()->findOrFail($nodeId);
    $after = [DocumentTestHelpers::document($fresh)->state_version, DocumentTestHelpers::revisions($fresh)->count()];
    expect($results[0]['kind'])->toBe('committed')
        ->and($fresh->trashed_at)->not->toBeNull()
        ->and($results[0]['pid'])->not->toBe($results[1]['pid'])
        ->and($results[1]['kind'])->toBeIn(['committed', 'node_not_found']);
    if ($results[1]['kind'] === 'node_not_found') {
        expect($after)->toBe($before)->and($results[1]['events'])->toBe(0)->and(Compaction::head($fresh))->toBeNull();
    }
});

it('a hub append racing an archive of its drive lands before it or is refused after it', function (): void {
    $node = RaceFixtures::document();
    $nodeId = $node->getKey();
    $before = [DocumentTestHelpers::document($node)->state_version, DocumentTestHelpers::revisions($node)->count()];

    $results = RaceFixtures::race([
        static fn (): array => RaceFixtures::attempt(static fn () => app(ArchiveDriveAction::class)->execute(
            DocumentTestHelpers::context(Node::query()->findOrFail($nodeId)),
        )),
        static fn (): array => RaceFixtures::attempt(static fn (): mixed => hubAppend(Node::query()->findOrFail($nodeId), $before[0])),
    ]);

    $fresh = Node::query()->findOrFail($nodeId);
    $after = [DocumentTestHelpers::document($fresh)->state_version, DocumentTestHelpers::revisions($fresh)->count()];
    expect($results[0]['kind'])->toBe('committed')
        ->and($fresh->storage()->firstOrFail()->status)->toBe(DriveStatus::Archived)
        ->and($results[1]['kind'])->toBeIn(['committed', 'permission_denied']);
    if ($results[1]['kind'] === 'permission_denied') {
        expect($after)->toBe($before)->and($results[1]['events'])->toBe(0)->and(Compaction::head($fresh))->toBeNull();
    }
});

it('a collaboration append racing drive deletion either commits before deletion or changes nothing', function (): void {
    Queue::fake();
    $node = RaceFixtures::document();
    $nodeId = $node->getKey();
    $before = [DocumentTestHelpers::document($node)->state_version, DocumentTestHelpers::revisions($node)->count()];
    $results = RaceFixtures::race([
        static fn (): array => RaceFixtures::attempt(static fn () => app(DeleteDriveAction::class)->execute(DocumentTestHelpers::context(Node::query()->findOrFail($nodeId)))),
        static fn (): array => RaceFixtures::attempt(static fn (): mixed => hubAppend(Node::query()->findOrFail($nodeId), $before[0])),
    ]);
    $fresh = Node::query()->findOrFail($nodeId);
    expect($results[0]['kind'])->toBe('committed')
        ->and($fresh->storage()->firstOrFail()->status)->toBe(DriveStatus::Deleting)
        ->and($results[1]['kind'])->toBeIn(['committed', 'node_not_found']);
    if ($results[1]['kind'] === 'node_not_found') {
        expect([DocumentTestHelpers::document($fresh)->state_version, DocumentTestHelpers::revisions($fresh)->count()])->toBe($before)
            ->and($results[1]['events'])->toBe(0)
            ->and(Compaction::head($fresh))->toBeNull();
    }
});
