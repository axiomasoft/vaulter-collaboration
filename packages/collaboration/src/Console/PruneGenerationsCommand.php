<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Console;

use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Persistence\RetiredGenerations;

/**
 * Delete the update log, receipts and head of the closed collaboration generations past their grace: retired
 * longer ago than `hub.token_ttl` + the hub's retry horizon (10 s) + `retention.retired_generation_days`. Until then a
 * late retry of such a generation still finds its receipt; it is refused either way (collaboration_epoch_mismatch). The
 * document's current generation is never touched.
 *
 * First the heads of generations a document left while the module was off are retired (they start their grace now).
 * --dry-run reports the generations it would delete and changes nothing. Schedulable
 * (`vaulter-collaboration.schedule.collaboration_prune`).
 */
#[Internal]
final class PruneGenerationsCommand extends Command
{
    protected $signature = 'vaulter:collaboration:prune
        {--dry-run : Report what would be pruned without deleting}';

    protected $description = 'Delete the log and receipts of closed collaboration generations past their grace.';

    public function handle(RetiredGenerations $generations, CollaborationOptions $config): int
    {
        $now = Carbon::now();
        $cutoff = $now->copy()->subSeconds($config->retiredGenerationGraceSeconds());

        if ($this->option('dry-run')) {
            $due = $generations->countDue($cutoff);
            $this->components->info(sprintf('Would prune %d closed generation%s retired before %s.', $due, $due === 1 ? '' : 's', $cutoff->toDateTimeString()));

            return self::SUCCESS;
        }

        $retired = $generations->retireLeft($now);
        $pruned = $generations->prune($cutoff);
        $this->components->info(sprintf(
            'Retired %d left generation%s; pruned %d closed generation%s retired before %s (%d update%s, %d receipt%s).',
            $retired,
            $retired === 1 ? '' : 's',
            $pruned['generations'],
            $pruned['generations'] === 1 ? '' : 's',
            $cutoff->toDateTimeString(),
            $pruned['updates'],
            $pruned['updates'] === 1 ? '' : 's',
            $pruned['receipts'],
            $pruned['receipts'] === 1 ? '' : 's',
        ));

        return self::SUCCESS;
    }
}
