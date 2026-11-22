<?php

declare(strict_types=1);

use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Sleep;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\FakeHub;
use Vaulter\Drive\Access\Roles\RoleRegistry;

/*
 * Scenario 12, uninstall (RemovalGuard): `vaulter:module:uninstall collaboration` is refused, the dry run included,
 * while a document carries a pending marker — those saved edits live only in the log --purge would delete. The guard
 * reads the documents' markers again inside the transaction of the purge, so an edit saved after the plan stops it too.
 * Once vaulter:collaboration:drain checkpointed every pending document, the removal goes through; the documents keep
 * their checkpoint.
 */

const UNINSTALL_GUARD_REFUSAL = 'module "collaboration" refuses it: 1 document(s) with saved collaboration edits not in a checkpoint yet';

/** @return array{updates: int, receipts: int, heads: int} */
function uninstallGuardRows(): array
{
    return [
        'updates' => Compaction::rows('collaboration_updates'),
        'receipts' => Compaction::rows('collaboration_receipts'),
        'heads' => Compaction::rows('collaboration_heads'),
    ];
}

beforeEach(function (): void {
    Hub::configure();
    Sleep::fake(syncWithCarbon: true);
    $this->pending = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
    $this->settled = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
});

it('refuses the removal while one document is pending, in the dry run and on --force --purge, and keeps its tables and rows', function (): void {
    Compaction::append($this->pending, 'saved', seed: true);
    $before = uninstallGuardRows();

    $this->artisan('vaulter:module:uninstall', ['module' => 'collaboration'])
        ->expectsOutputToContain(UNINSTALL_GUARD_REFUSAL)
        ->expectsOutputToContain('Dry run: nothing was changed.')
        ->assertExitCode(1);
    $this->artisan('vaulter:module:uninstall', ['module' => 'collaboration', '--force' => true, '--purge' => true])
        ->expectsOutputToContain(UNINSTALL_GUARD_REFUSAL)
        ->expectsOutputToContain('nothing was changed')
        ->assertExitCode(1);

    expect(Schema::hasTable('v_collaboration_updates'))->toBeTrue()
        ->and(Schema::hasTable('v_collaboration_receipts'))->toBeTrue()
        ->and(Schema::hasTable('v_collaboration_heads'))->toBeTrue()
        ->and(uninstallGuardRows())->toBe($before)
        ->and($before)->toBe(['updates' => 1, 'receipts' => 1, 'heads' => 1])
        ->and(Compaction::marker($this->pending))->toBe([0, 1])
        ->and(Compaction::marker($this->settled))->toBe([null, null]);
});

it('removes the module once the drain checkpointed every pending document; the documents keep their checkpoint', function (): void {
    FakeHub::install();
    Compaction::append($this->pending, 'saved', seed: true);

    $this->artisan('vaulter:collaboration:drain')->assertExitCode(0);
    $this->artisan('vaulter:module:uninstall', ['module' => 'collaboration', '--force' => true, '--purge' => true])
        ->expectsOutputToContain('Removal guards')
        ->expectsOutputToContain('The schema of "collaboration" is removed.')
        ->assertExitCode(0);

    expect(Schema::hasTable('v_collaboration_updates'))->toBeFalse()
        ->and(Schema::hasTable('v_collaboration_receipts'))->toBeFalse()
        ->and(Schema::hasTable('v_collaboration_heads'))->toBeFalse()
        ->and(Schema::hasTable('v_documents'))->toBeTrue()
        ->and(Hub::aggregate($this->pending)->syncState?->collab_state)->toBe('saved')
        ->and(Compaction::marker($this->pending))->toBe([null, null]);
});

it('reads the markers again inside the purge transaction: an edit saved after the plan read them stops the removal', function (): void {
    $late = false;
    DB::listen(function (QueryExecuted $query) use (&$late): void {
        // The plan's read of the markers; the edit commits right after it, as a writer that was not switched off would.
        if (!$late && preg_match('/pending_generation\W+is not null/i', $query->sql) === 1) {
            $late = true;
            Compaction::append($this->pending, 'late', seed: true);
        }
    });

    $this->artisan('vaulter:module:uninstall', ['module' => 'collaboration', '--force' => true, '--purge' => true])
        ->expectsOutputToContain(UNINSTALL_GUARD_REFUSAL)
        ->expectsOutputToContain('nothing was changed')
        ->assertExitCode(1);

    expect($late)->toBeTrue()
        ->and(Schema::hasTable('v_collaboration_updates'))->toBeTrue()
        ->and(uninstallGuardRows())->toBe(['updates' => 1, 'receipts' => 1, 'heads' => 1])
        ->and(Compaction::marker($this->pending))->toBe([0, 1]);
});
