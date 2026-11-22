<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Vaulter\Collaboration\Persistence\Checkpoint;
use Vaulter\Collaboration\Persistence\CheckpointRequest;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Concurrency\RaceFixtures;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Testing\Concurrency\ForkRace;

/**
 * Scenarios 4 and 5 on PostgreSQL: the publication of a checkpoint races an append and a second publication of
 * the same (C, H) on separate backends. The document lock and the head row serialize them: an append that commits
 * around the publication keeps its payload and the marker past H whichever goes first; of two publications of the same
 * lease exactly one commits, the other answers collaboration_checkpoint_conflict, and the log holds HS − H updates.
 */
beforeEach(function (): void {
    ForkRace::skipUnlessSupported($this, app(VaulterDatabase::class)->connection()->getName());
    Hub::configure();
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
});

it('keeps an update appended while H is published, its payload and the marker past H', function (): void {
    $node = RaceFixtures::document();
    Compaction::append($node, 'u1');
    Compaction::append($node, 'u2');
    $request = Compaction::request(Compaction::leaseOf($node));
    $nodeId = $node->getKey();

    $results = RaceFixtures::race([
        static fn (): array => RaceFixtures::attempt(static function () use ($request): void {
            app(Checkpoint::class)->publish($request);
        }),
        static fn (): array => RaceFixtures::attempt(static function () use ($nodeId): void {
            app(UpdateLog::class)->append($nodeId, new UpdateEnvelope(generation: 0, updateId: '00000000-0000-4000-8000-000000000003', payload: 'u3', claimedSha256: hash('sha256', 'u3')));
        }),
    ]);

    $document = Hub::aggregate($node);
    expect(array_column($results, 'kind'))->toBe(['committed', 'committed'])
        ->and(Compaction::seqs($node))->toBe([3])
        ->and(DB::table(app(DatabaseOptions::class)->table('collaboration_receipts'))->count())->toBe(3)
        ->and([$document->pending_generation, $document->pending_through_seq])->toBe([0, 3])
        ->and(Compaction::head($node)?->checkpointSeq)->toBe(2);
});

it('commits exactly one of two publications of the same (C, H) and leaves HS − H updates', function (): void {
    $node = RaceFixtures::document();
    foreach (['u1', 'u2'] as $payload) {
        Compaction::append($node, $payload);
    }
    $request = Compaction::request(Compaction::leaseOf($node));
    Compaction::append($node, 'u3');
    $publish = static fn (CheckpointRequest $request): Closure => static fn (): array => RaceFixtures::attempt(static function () use ($request): void {
        app(Checkpoint::class)->publish($request);
    });

    $results = RaceFixtures::race([$publish($request), $publish($request)]);

    $kinds = array_column($results, 'kind');
    sort($kinds);
    expect($kinds)->toBe(['collaboration_checkpoint_conflict', 'committed'])
        ->and(count(Compaction::seqs($node)))->toBe(3 - 2)
        ->and(Hub::aggregate($node)->pending_through_seq)->toBe(3)
        ->and(Compaction::head($node)?->checkpointSeq)->toBe(2);
});
