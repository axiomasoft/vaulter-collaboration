<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Console;

use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Sleep;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Drain\DrainState;
use Vaulter\Collaboration\Drain\DrainWaiter;
use Vaulter\Collaboration\Drain\PendingDocuments;
use Vaulter\Collaboration\Persistence\CompactionLeases;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\PendingMarker;

/**
 * The managed disable of the collaboration module: set the draining flag ({@see DrainState}) — from then on
 * every append is refused with 503 collaboration_draining — and ask the hub's compaction worker to checkpoint every
 * document that carries a pending marker (drain_requested_at), then wait outside any transaction until no document
 * carries one or `--deadline` seconds passed. The outcome is what CollaborativeState::pendingDocuments() reads at the
 * end, never what the hub answered, and it is read no earlier than `drain.max_append_tx` after the flag was set. An
 * append reads the flag again as the last statement of its transaction (UpdateLog::append()) and rolls back when it is
 * set, so one that missed the flag had passed every lock wait and write before the flag was set, and only its commit
 * is left in that window. A marker that appears meanwhile is drained too.
 *
 * Exit 0: no document is pending, the module can be switched off (`vaulter.modules.collaboration=false`) and removed.
 * Exit 1: documents are still pending (the hub is down, the deadline passed); each is listed, nothing was lost, and the
 * command can be repeated. The flag stays in both cases, until `--release` removes it (exit 0). Exit 1 as well when the
 * cache store did not keep the flag: appends are still accepted, nothing was asked of the hub. Exit 2: a bad option.
 */
#[Internal]
final class DrainCommand extends Command
{
    protected $signature = 'vaulter:collaboration:drain
        {--deadline=30 : Seconds to wait for the hub to checkpoint every pending document}
        {--release : Remove the draining flag: appends are accepted again}';

    protected $description = 'Refuse new collaboration updates and checkpoint every pending document through the hub before the module is switched off.';

    public function handle(DrainState $state, PendingDocuments $documents, CompactionLeases $leases, DrainWaiter $waiter, CollaborationOptions $config, VaulterDatabase $database): int
    {
        if ($this->option('release') === true) {
            $this->components->info($state->release()
                ? 'The draining flag is removed: the collaboration log accepts updates again.'
                : 'The collaboration log was not draining: nothing to release.');

            return self::SUCCESS;
        }
        $deadline = filter_var($this->option('deadline'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($deadline)) {
            $this->components->error('--deadline takes a whole number of seconds, at least 1.');

            return self::INVALID;
        }
        // The hub merges while this waits: no lock may be held, so not inside a transaction.
        if ($database->connection()->transactionLevel() > 0) {
            $this->components->error('The drain waits for the hub and cannot run inside a database transaction.');

            return self::FAILURE;
        }

        $since = $state->begin();
        if ($since === null) {
            $this->components->error(sprintf(
                'The cache store %s did not keep the draining flag: appends are still accepted, nothing was drained. Fix the store (vaulter-collaboration.drain.cache_store), then repeat the drain.',
                $config->drainCacheStore() ?? '(default)',
            ));

            return self::FAILURE;
        }
        // An append that missed the flag reads it again before its commit: within this window only that commit is left.
        $quiet = $since->copy()->addSeconds($config->drainMaxAppendTx());
        $until = Carbon::now()->addSeconds($deadline)->max($quiet);
        $this->components->info(sprintf(
            'Appends are refused since %s. Waiting until %s at most for the hub to checkpoint the pending documents.',
            $since->toDateTimeString(),
            $until->toDateTimeString(),
        ));

        /** @var array<string, true> $requested */
        $requested = [];
        /** @var list<PendingMarker> $pending */
        $pending = [];
        // Read the markers again, ask for the drain of each one not asked for yet (a later append raises its sequence),
        // and settle only once none is left and the appends that missed the flag have ended.
        $settled = function () use ($documents, $leases, $quiet, &$requested, &$pending): bool {
            $pending = $documents->all();
            foreach ($pending as $marker) {
                $key = $marker->documentId.':'.$marker->generation.':'.$marker->throughSeq;
                if (!isset($requested[$key])) {
                    $requested[$key] = true;
                    $leases->requestDrain($marker);
                }
            }

            return $pending === [] && Carbon::now()->greaterThanOrEqualTo($quiet);
        };

        while (!$settled()) {
            $remaining = $until->getTimestampMs() - Carbon::now()->getTimestampMs();
            if ($remaining <= 0) {
                break;
            }
            if ($pending === []) {
                // Nothing to drain yet: wait out the appends that may still commit a marker.
                Sleep::for(max(1, min($remaining, $quiet->getTimestampMs() - Carbon::now()->getTimestampMs())))->milliseconds();

                continue;
            }
            $waiter->wait($pending[0], $settled, (int) ceil($remaining / 1000));
        }

        $left = $documents->all();
        if ($left === []) {
            $this->components->info('No document is pending: switch the module off (vaulter.modules.collaboration=false), or remove it with vaulter:module:uninstall collaboration.');

            return self::SUCCESS;
        }
        foreach ($left as $marker) {
            $this->line('  <fg=red>pending:</> '.self::describe($marker));
        }
        $this->components->error(sprintf(
            '%d document(s) still have saved collaboration edits that are not in a checkpoint. Make sure the hub runs, then repeat the drain; appends stay refused until --release.',
            count($left),
        ));

        return self::FAILURE;
    }

    private static function describe(PendingMarker $marker): string
    {
        return sprintf('document_id %s (node %s, generation %d, through seq %d)', $marker->documentId, $marker->nodeId, $marker->generation, $marker->throughSeq);
    }
}
