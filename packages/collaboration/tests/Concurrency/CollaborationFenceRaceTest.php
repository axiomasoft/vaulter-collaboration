<?php

declare(strict_types=1);

use Illuminate\Support\Str;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Concurrency\RaceFixtures;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Actions\Revisions\RestoreDocumentRevisionAction;
use Vaulter\Documents\Data\Revisions\RestoreDocumentRevisionInput;
use Vaulter\Drive\Models\Node;
use Vaulter\Testing\Concurrency\ForkRace;

/**
 * The generation fence under real concurrency (PostgreSQL, separate backends): an append of the room opened before a
 * restore either commits before the restore — whose pending marker then keeps the restore from closing the generation
 * over it (409 document_state_pending without a drainer) — or is refused after it; the restored generation never holds
 * a record of the old room. Two hub instances seeding the same empty generation: exactly one seed is appended.
 */
beforeEach(function (): void {
    ForkRace::skipUnlessSupported($this, app(VaulterDatabase::class)->connection()->getName());
});

function fenceRaceAppend(Node $node, string $payload, ?int $seedStateVersion = null): mixed
{
    return app(UpdateLog::class)->append($node->getKey(), new UpdateEnvelope(
        generation: 0,
        updateId: (string) Str::uuid(),
        payload: $payload,
        claimedSha256: hash('sha256', $payload),
        origin: $seedStateVersion === null ? 'client' : 'server',
        seedStateVersion: $seedStateVersion,
    ));
}

it('serializes an append of the old room against a restore: never a record of the old room under the new epoch', function (): void {
    $node = RaceFixtures::document();
    $first = DocumentTestHelpers::head($node);
    $version = DocumentTestHelpers::document($node)->state_version;

    // The room's first record of an empty generation is its seed; the log takes no client update before it.
    $results = RaceFixtures::race([
        static fn (): array => RaceFixtures::attempt(static fn (): mixed => fenceRaceAppend($node, 'late-room-seed', $version)),
        static fn (): array => RaceFixtures::attempt(static fn () => app(RestoreDocumentRevisionAction::class)->execute(
            DocumentTestHelpers::context($node, actorId: 1), new RestoreDocumentRevisionInput(node: $node, revision: $first),
        )),
    ]);
    $document = DocumentTestHelpers::document($node);
    $outcome = [$results[0]['kind'], $results[1]['kind']];

    // Append first (its marker refuses the restore), or restore first (the append's generation is over).
    expect($outcome)->toBeIn([['committed', 'document_state_pending'], ['collaboration_epoch_mismatch', 'committed']]);
    if ($outcome[0] === 'committed') {
        expect($document->collab_epoch)->toBe(0)
            ->and(Compaction::seqs($node, 0))->toBe([1])
            ->and(Compaction::marker($node))->toBe([0, 1]);
    } else {
        expect($document->collab_epoch)->toBe(1)
            ->and(Compaction::head($node, 0))->toBeNull()
            ->and(Compaction::marker($node))->toBe([null, null]);
    }
});

it('lets exactly one of two concurrent seeds of an empty generation through', function (): void {
    $node = RaceFixtures::document();
    $version = DocumentTestHelpers::document($node)->state_version;

    $results = RaceFixtures::race([
        static fn (): array => RaceFixtures::attempt(static fn (): mixed => fenceRaceAppend($node, 'seed-a', $version)),
        static fn (): array => RaceFixtures::attempt(static fn (): mixed => fenceRaceAppend($node, 'seed-b', $version)),
    ]);
    $kinds = array_column($results, 'kind');
    sort($kinds);

    expect($kinds)->toBe(['collaboration_seed_conflict', 'committed'])
        ->and(Compaction::seqs($node))->toBe([1])
        ->and(Compaction::marker($node))->toBe([0, 1])
        ->and(DocumentTestHelpers::document($node)->state_version)->toBe($version);
});
