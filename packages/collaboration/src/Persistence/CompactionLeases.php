<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Closure;
use Generator;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\RoomOwnership;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Exceptions\NotADocumentException;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\LockedDocumentState;
use Vaulter\Documents\State\PendingMarker;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Support\Identity;

/**
 * Compaction leases: PHP does not merge Yjs, so the hub's compaction worker asks for the document generations
 * due for a checkpoint, merges each checkpoint with its tail and publishes the result through {@see Checkpoint}. A
 * lease is the one right to publish a generation's next checkpoint until it expires; it gives no right to append.
 *
 * A generation is leased only while it is the document's current one, not retired, and carries uncheckpointed edits
 * (the documents' pending marker) or a drain request. The lease is granted, and the checkpoint and tail read, in one
 * transaction under the document lock (CollaborativeState::lock()) and the head row FOR UPDATE.
 */
#[Spi(SpiKind::Call)]
final readonly class CompactionLeases
{
    /** The most generations one lease call hands out. */
    public const int MAX = 100;

    /** The most generations a report of what is still due names; it counts them all. */
    public const int REPORTED = 20;

    /** The pending markers read per transaction while a report counts. */
    private const int PAGE = 100;

    #[Internal]
    public function __construct(
        private VaulterDatabase $database,
        private LogTables $log,
        private CollaborativeState $state,
        private UpdateLog $updates,
        private CollaborationOptions $config,
        private RoomOwnership $rooms,
    ) {}

    /**
     * Lease up to `$max` generations to hub `$hubId`: those with a drain request first, then those whose uncheckpointed
     * log reached a trigger (`compaction.trigger_updates`, `trigger_bytes` or `trigger_age`). A generation another lease
     * holds is skipped. The entries carry at most `max_state_bytes` of state: a generation is measured under the locks
     * before its tail is read, and the call ends at the first one that would carry it past the budget, neither read nor
     * leased (a later call hands it out). Only a first entry larger than the whole budget goes out alone, or it would
     * never be compacted.
     *
     * @return list<CompactionLease>
     */
    public function grant(string $hubId, int $max, string $protocol = CollaborationOptions::JWT_PROTOCOL): array
    {
        $leases = [];
        $room = $this->config->maxStateBytes();
        foreach ($this->candidates($protocol) as $candidate) {
            $lease = $this->lease($candidate, $hubId, $leases === [] ? null : $room);
            if ($lease === false) {
                break;
            }
            if ($lease === null) {
                continue;
            }
            $leases[] = $lease;
            $room -= $lease->bytes();
            if (count($leases) >= $max || $room <= 0) {
                break;
            }
        }

        return $leases;
    }

    /**
     * What is still due for compaction, whichever hub holds its lease: the generations whose document carries their
     * pending marker, open, with a drain request or past a trigger — what a lease call hands out now, or once a lease
     * that holds one is spent or ran out. Only an empty report shows the hub's `compact --pending` that nothing is left:
     * an empty lease answer does not, another hub's lease hides a generation from it. The markers are read through the
     * documents state contract page by page, each page in a short transaction of its own, the heads without locks.
     * `generations` names the first `$limit` in document id order; `total` counts them all.
     *
     * @return array{total: int, generations: list<array{document: string, generation: int}>}
     */
    #[Internal]
    public function pending(int $limit = self::REPORTED, string $protocol = CollaborationOptions::JWT_PROTOCOL): array
    {
        $binding = explode('/', $protocol, 2)[0];
        if ($this->rooms->registeredDriver($binding)?->version() !== $protocol) {
            return ['total' => 0, 'generations' => []];
        }
        $now = Carbon::now();
        $total = 0;
        $generations = [];
        $after = null;
        do {
            $page = $this->database->transaction(fn (): array => $this->state->pendingDocuments(self::PAGE, $after, protocol: $binding));
            foreach ($page as $marker) {
                $after = Identity::key($marker->documentId);
                $head = $this->log->heads($this->log->rows('collaboration_heads', $marker->documentId, $marker->generation))[0] ?? null;
                if ($head === null || $head->protocol !== $protocol || $head->retiredAt !== null
                    || ($head->drainRequestedAt === null && !$this->due($head, $now))) {
                    continue;
                }
                $total++;
                if (count($generations) < $limit) {
                    $generations[] = ['document' => $marker->nodeId, 'generation' => $marker->generation];
                }
            }
        } while (count($page) === self::PAGE);

        return ['total' => $total, 'generations' => $generations];
    }

    /**
     * Ask for the compaction of the document's current generation (a drain): a short transaction of its own sets
     * drain_requested_at under the document and head locks, and the next lease call hands the generation out first.
     * False when there is nothing to drain: the document carries no marker, or its generation has no open log.
     */
    public function requestDrain(PendingMarker $marker): bool
    {
        return $this->database->transaction(function () use ($marker): bool {
            try {
                $locked = $this->state->lock($marker->nodeId);
            } catch (NodeNotFoundException|NotADocumentException) {
                return false;
            }
            if ($locked->pending === null || $locked->pending->generation !== $locked->generation || !$locked->pending->binding->sameAs($marker->binding)) {
                return false;
            }
            $head = $this->log->lockHead($locked->documentId, $locked->generation);
            if ($head === null || $head->retiredAt !== null) {
                return false;
            }
            if ($head->drainRequestedAt === null) {
                $now = Carbon::now();
                $this->log->rows('collaboration_heads', $locked->documentId, $locked->generation)->update(['drain_requested_at' => $now, 'updated_at' => $now]);
            }

            return true;
        });
    }

    /**
     * The head rows worth a lease, read without locks (each is checked again under them): drain requests, then the
     * generations with uncheckpointed updates that reached a trigger.
     *
     * @return Generator<int, Head>
     */
    private function candidates(string $protocol): Generator
    {
        $now = Carbon::now();
        $leaseNow = $this->log->leaseClock();
        foreach ($this->scan(static fn (Builder $query): Builder => $query->whereNotNull('drain_requested_at'), $leaseNow, $protocol) as $head) {
            yield $head;
        }
        $pending = static fn (Builder $query): Builder => $query->whereNull('drain_requested_at')->whereColumn('head_seq', '>', 'checkpoint_seq');
        foreach ($this->scan($pending, $leaseNow, $protocol) as $head) {
            if ($this->due($head, $now)) {
                yield $head;
            }
        }
    }

    /**
     * The open head rows no lease holds that `$filter` selects.
     *
     * @param  Closure(Builder): Builder $filter
     * @return Generator<int, Head>
     */
    private function scan(Closure $filter, Carbon $now, string $protocol): Generator
    {
        $cutoff = $this->log->timestamp($now->copy()->utc());

        return $this->log->scan(static fn (Builder $query): Builder => $filter($query)
            ->whereNull('retired_at')
            ->where('protocol', $protocol)
            ->where(static fn (Builder $query): Builder => $query->whereNull('lease_expires_at')->orWhere('lease_expires_at', '<=', $cutoff)));
    }

    /** Whether the uncheckpointed log of `$head` reached a compaction trigger at `$now`. */
    private function due(Head $head, Carbon $now): bool
    {
        $strict = $head->profile === 'strict';
        if ($head->headSeq - $head->checkpointSeq >= ($strict ? 200 : $this->config->compactionTriggerUpdates())) {
            return true;
        }

        $triggerTime = $strict ? $head->tailLatestAt : $head->tailOldestAt;

        return $head->tailBytes >= ($strict ? 256 * 1024 : $this->config->compactionTriggerBytes())
            || ($triggerTime !== null && $triggerTime->lessThanOrEqualTo($now->copy()->subSeconds($strict ? 60 : $this->config->compactionTriggerAge())));
    }

    /**
     * The lease on `$candidate`; null when it is not leasable under the locks any more, false when its checkpoint and
     * tail would carry more than `$room` bytes (null: no limit): then nothing was read or leased.
     */
    private function lease(Head $candidate, string $hubId, ?int $room): CompactionLease|false|null
    {
        return $this->database->transaction(function () use ($candidate, $hubId, $room): CompactionLease|false|null {
            $locked = $this->state->lockByDocumentId($candidate->documentId);
            if ($locked === null) {
                return null;
            }
            // A generation a restore closed while the module was off is never compacted: the prune retires it.
            if ($locked->binding === null || !str_starts_with($candidate->protocol, $locked->binding->protocol.'/')
                || $locked->generation !== $candidate->generation) {
                return null;
            }
            $head = $this->log->lockHead($locked->documentId, $locked->generation);
            if ($head === null || $head->retiredAt !== null || $head->protocol !== $candidate->protocol
                || $head->leased($this->log->leaseClock())) {
                return null;
            }
            $pending = $locked->pending !== null && $locked->pending->generation === $locked->generation;
            if ($head->drainRequestedAt === null && (!$pending || !$this->due($head, Carbon::now()))) {
                return null;
            }
            // Measured before the tail is read: a generation over the budget is never loaded into memory here.
            if ($room !== null && $this->size($locked, $head) > $room) {
                return false;
            }

            $snapshot = $this->updates->read($locked);
            $token = LeaseBinding::issue($locked->documentId, $snapshot->type, $snapshot->binding, $head->checkpointVersion);
            // The column keeps whole seconds: the lease ends at the second it reports.
            $now = $this->log->leaseClock();
            $expiresAt = $now->copy()->addSeconds($this->config->compactionLeaseTtl())->startOfSecond();
            $this->log->rows('collaboration_heads', $locked->documentId, $locked->generation)->update([
                'lease_token' => $token,
                'lease_owner' => $hubId,
                'lease_expires_at' => $this->log->timestamp($expiresAt),
                'lease_through_seq' => $head->headSeq,
                'updated_at' => $now,
            ]);

            return new CompactionLease(
                nodeId: $locked->nodeId,
                protocol: $head->protocol,
                token: $token,
                expiresAt: $expiresAt,
                checkpointVersion: $head->checkpointVersion,
                leaseThroughSeq: $head->headSeq,
                log: $snapshot,
            );
        });
    }

    /**
     * The bytes the entry of `$head` would carry, as CompactionLease::bytes() counts them (the checkpoint's binary size,
     * the base64 tail), read under the document and head locks without loading either.
     */
    private function size(LockedDocumentState $locked, Head $head): int
    {
        return ($locked->collabStateSize ?? 0) + $head->tailWireBytes;
    }
}
