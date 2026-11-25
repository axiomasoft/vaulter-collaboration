<?php

declare(strict_types=1);

use Illuminate\Database\QueryException;
use Vaulter\Collaboration\Exceptions\CollaborationCheckpointConflictException;
use Vaulter\Collaboration\Persistence\CheckpointResult;
use Vaulter\Collaboration\Persistence\LogTables;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Database\VaulterDatabase;

it('rejects publication of 42 under a lease for 41 and preserves the unmerged tail on publication of 41', function (): void {
    Hub::configure();
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $node = Hub::document();
    for ($seq = 1; $seq <= 40; $seq++) {
        Compaction::append($node, 'update '.$seq);
    }
    Compaction::publish(Compaction::leaseOf($node));

    Compaction::append($node, 'update 41');
    $lease = Compaction::leaseOf($node);
    $late = Compaction::append($node, 'update 42');
    $version = $lease->checkpointVersion;

    expect([$lease->log->checkpointSeq, $lease->log->headSeq, $late->seq])->toBe([40, 41, 42]);
    expect(fn (): CheckpointResult => Compaction::publish($lease, 42))->toThrow(
        CollaborationCheckpointConflictException::class,
        CollaborationCheckpointConflictException::COVERAGE,
    );

    $head = Compaction::head($node);
    expect([$head?->checkpointSeq, $head?->headSeq, $head?->checkpointVersion])->toBe([40, 42, $version])
        ->and($head?->leaseToken)->toBe($lease->token)
        ->and(Compaction::seqs($node))->toBe([41, 42])
        ->and(Compaction::marker($node))->toBe([$lease->log->generation, 42]);

    expect(Compaction::publish($lease, 41)->markerCleared)->toBeFalse();
    $snapshot = app(UpdateLog::class)->snapshot($node->getKey(), $lease->log->generation);
    $head = Compaction::head($node);
    expect([$head?->checkpointSeq, $head?->headSeq, $head?->leaseThroughSeq])->toBe([41, 42, null])
        ->and($snapshot->checkpoint)->toBe(Compaction::merged($lease))
        ->and($snapshot->tail)->toBe([['seq' => 42, 'update_id' => $late->updateId, 'payload' => base64_encode('update 42')]])
        ->and(Compaction::marker($node))->toBe([$lease->log->generation, 42])
        ->and(Compaction::rows('collaboration_receipts'))->toBe(42);
});

it('requires a complete lease with a bound within the generation head', function (array $lease): void {
    Hub::configure();
    $node = Hub::document();
    Compaction::append($node, 'seed');
    $document = Hub::aggregate($node);
    $head = app(LogTables::class)->rows('collaboration_heads', (string) $document->getKey(), $document->collab_epoch);

    expect(fn () => app(VaulterDatabase::class)->transaction(fn () => $head->update($lease)))
        ->toThrow(QueryException::class, 'v_collaboration_heads_compaction_lease');
    expect(Compaction::head($node)?->leaseToken)->toBeNull();
})->with([
    'token without a bound' => [['lease_token' => 'token', 'lease_owner' => 'hub', 'lease_expires_at' => '2037-01-01 00:00:00']],
    'bound beyond the head' => [['lease_token' => 'token', 'lease_owner' => 'hub', 'lease_expires_at' => '2037-01-01 00:00:00', 'lease_through_seq' => 2]],
    'bound without a token' => [['lease_through_seq' => 1]],
]);

it('rejects a lease at its deadline even when the PHP clock on PostgreSQL is behind', function (): void {
    Hub::configure();
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $node = Hub::document();
    Compaction::append($node, 'seed');
    $lease = Compaction::leaseOf($node);
    $deadline = Compaction::expireLease($node);
    $postgres = app(VaulterDatabase::class)->connection()->getDriverName() === 'pgsql';
    $this->travelTo($deadline->copy()->subSeconds($postgres ? 60 : 0));

    expect(fn (): CheckpointResult => Compaction::publish($lease))
        ->toThrow(CollaborationCheckpointConflictException::class, CollaborationCheckpointConflictException::LEASE);
    expect(Compaction::seqs($node))->toBe([1]);

    if ($postgres) {
        $column = app(VaulterDatabase::class)->connection()->selectOne(
            "select data_type, datetime_precision from information_schema.columns where table_schema = 'public' and table_name = 'v_collaboration_heads' and column_name = 'lease_expires_at'",
        );
        expect($column?->data_type)->toBe('timestamp with time zone')
            ->and((int) $column?->datetime_precision)->toBe(6);
    }
});
