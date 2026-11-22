<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Closure;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\LockedDocumentState;

/**
 * The end of a closed generation's log. A generation is closed when the document moved past it (a restore or a
 * REST replace, {@see GenerationCloser}); its updates, receipts and head are deleted only once retired_at is older
 * than the grace the caller passes — the last token of the generation and the hub's retry horizon have run out, then
 * the retention window. Until then a late retry still finds its receipt; before and after the prune it is refused the
 * same way (collaboration_epoch_mismatch).
 *
 * Every change is made per generation under the document lock (CollaborativeState::lock()) and the head row FOR
 * UPDATE, and checks again there that the generation is not the document's current one: an active generation is
 * never retired or pruned.
 */
#[Internal]
final readonly class RetiredGenerations
{
    public function __construct(
        private VaulterDatabase $database,
        private LogTables $log,
        private CollaborativeState $state,
    ) {}

    /**
     * Retire the open heads of generations their document already left — closed while the module was off, so no event
     * sink saw it. Returns how many were retired.
     */
    public function retireLeft(Carbon $now): int
    {
        $retired = 0;
        foreach ($this->log->scan(static fn (Builder $query): Builder => $query->whereNull('retired_at')) as $head) {
            $retired += $this->locked($head, function (LockedDocumentState $locked) use ($head, $now): int {
                if ($head->generation >= $locked->generation) {
                    return 0;
                }

                return $this->log->rows('collaboration_heads', $head->documentId, $head->generation)
                    ->whereNull('retired_at')
                    ->update(['retired_at' => $now, 'updated_at' => $now]);
            }) ?? 0;
        }

        return $retired;
    }

    /** How many retired generations a prune with `$cutoff` would delete. */
    public function countDue(Carbon $cutoff): int
    {
        return $this->due($this->log->table('collaboration_heads'), $cutoff)->count();
    }

    /**
     * Delete the updates, receipts and head of every generation retired before `$cutoff`.
     *
     * @return array{generations: int, updates: int, receipts: int}
     */
    public function prune(Carbon $cutoff): array
    {
        $pruned = ['generations' => 0, 'updates' => 0, 'receipts' => 0];
        foreach ($this->log->scan(fn (Builder $query): Builder => $this->due($query, $cutoff)) as $head) {
            $rows = $this->locked($head, function (LockedDocumentState $locked) use ($head, $cutoff): array {
                if ($head->generation === $locked->generation) {
                    return [];
                }
                $current = $this->log->lockHead($head->documentId, $head->generation);
                if ($current?->retiredAt === null || !$current->retiredAt->lessThan($cutoff)) {
                    return [];
                }

                return [
                    'updates' => $this->log->rows('collaboration_updates', $head->documentId, $head->generation)->delete(),
                    'receipts' => $this->log->rows('collaboration_receipts', $head->documentId, $head->generation)->delete(),
                    'generations' => $this->log->rows('collaboration_heads', $head->documentId, $head->generation)->delete(),
                ];
            });
            foreach ($rows ?? [] as $kind => $count) {
                $pruned[$kind] += $count;
            }
        }

        return $pruned;
    }

    private function due(Builder $query, Carbon $cutoff): Builder
    {
        return $query->whereNotNull('retired_at')->where('retired_at', '<', $cutoff);
    }

    /**
     * `$change` in a transaction of its own under the lock of the head's document; nothing when the document is gone.
     *
     * @template T
     *
     * @param  Closure(LockedDocumentState): T $change
     * @return T|null
     */
    private function locked(Head $head, Closure $change): mixed
    {
        return $this->database->transaction(function () use ($head, $change): mixed {
            $locked = $this->state->lockByDocumentId($head->documentId);

            return $locked !== null ? $change($locked) : null;
        });
    }
}
