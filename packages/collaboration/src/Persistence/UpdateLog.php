<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Closure;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Carbon;
use LogicException;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Drain\DrainState;
use Vaulter\Collaboration\Exceptions\CollaborationDrainingException;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\Exceptions\CollaborationSeedConflictException;
use Vaulter\Collaboration\Exceptions\CollaborationUpdateMismatchException;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\LockedDocumentState;
use Vaulter\Drive\Enums\Access\Ability;
use Vaulter\Drive\Enums\DriveStatus;
use Vaulter\Drive\Exceptions\Access\PermissionDeniedException;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Support\Identity;

/**
 * The update log of a document generation. An append reads the draining flag first ({@see DrainState},
 * Refused while a managed disable drains the log), then takes the documents' lock order through
 * CollaborativeState::lock() (T → N → D), then the head row of the generation FOR UPDATE (created on the first
 * append under the same locks); it fences the generation, answers a known update id from its receipt, and otherwise
 * writes the update, its receipt, the new head and the documents' pending marker in one transaction, which reads the
 * flag once more before it commits. The caller builds the ack from the result, after the commit.
 *
 * The log is written only here, and v_documents never: the marker goes through the documents state contract.
 */
#[Internal]
final readonly class UpdateLog
{
    public function __construct(
        private VaulterDatabase $database,
        private DatabaseOptions $tables,
        private CollaborativeState $state,
        private DrainState $draining,
        private YjsStateCompatibility $compatibility,
    ) {}

    /**
     * @param (Closure(LockedDocumentState): void)|null $authorize
     *
     * @throws CollaborationDrainingException       a managed disable drains the log; nothing was written
     * @throws NodeNotFoundException                the node is gone or in the trash, or its drive is being deleted
     * @throws PermissionDeniedException            its drive was archived after the room was opened
     * @throws CollaborationEpochMismatchException  the generation is not the document's current one, or it was retired
     * @throws CollaborationUpdateMismatchException the claimed hash is wrong, or the id was committed with another payload
     * @throws CollaborationSeedConflictException   a seed over a log that is no longer empty, or over newer JSON
     */
    public function append(int|string $nodeId, UpdateEnvelope $update, ?Closure $authorize = null): AppendResult
    {
        // Before any lock, and again before the commit (below): a draining log takes no lock at all.
        $this->draining->assertAccepting();
        $sha256 = $update->sha256();
        if (!hash_equals($sha256, strtolower($update->claimedSha256))) {
            throw CollaborationUpdateMismatchException::hash($update->updateId);
        }

        return $this->database->transaction(function () use ($nodeId, $update, $sha256, $authorize): AppendResult {
            $locked = $this->state->lock($nodeId);
            $authorize?->__invoke();
            $this->compatibility->assert($locked->type, $locked->binding, $locked->collabState !== null);
            if ($locked->trashed) {
                throw NodeNotFoundException::forId($nodeId);
            }
            $this->fence($locked, $update->generation);
            $head = $this->lockHead($locked);

            $receipt = $this->findReceipt($locked->documentId, $update->generation, $update->updateId, lock: true);
            if ($receipt instanceof Receipt) {
                if (!hash_equals($receipt->sha256, $sha256)) {
                    throw CollaborationUpdateMismatchException::receipt($update->updateId);
                }

                return new AppendResult($locked->documentId, $update->generation, $update->updateId, $receipt->seq, $receipt->sha256, duplicate: true);
            }
            $this->assertDriveWritable($locked);
            $checkpointed = $locked->collabStateSize !== null;
            if ($head['head_seq'] === 0 && !$checkpointed && $update->seedStateVersion === null) {
                throw new CollaborationSeedConflictException($locked->nodeId);
            }
            if ($update->seedStateVersion !== null) {
                $this->assertSeedable($locked, $head, $update->seedStateVersion);
            }

            $seq = $head['head_seq'] + 1;
            $now = Carbon::now();
            $key = ['document_id' => Identity::key($locked->documentId), 'generation' => $update->generation];
            $this->table('collaboration_updates')->insert($key + [
                'seq' => $seq,
                'update_id' => $update->updateId,
                // Base64 binds the binary losslessly (NUL-safe) on every driver, as the documents checkpoint does.
                'payload' => base64_encode($update->payload),
                'sha256' => $sha256,
                'created_at' => $now,
            ]);
            $this->table('collaboration_receipts')->insert($key + [
                'update_id' => $update->updateId,
                'seq' => $seq,
                'sha256' => $sha256,
                'committed_at' => $now,
            ]);
            $this->heads($locked->documentId, $update->generation)->update(['head_seq' => $seq, 'updated_at' => $now]);
            $this->state->markPending($locked, $locked->binding ?? throw new LogicException('Missing collaboration binding.'), $seq);
            // Read again as the last statement before the commit, after every lock wait and write: a flag set meanwhile
            // rolls the append back, so what a drain waits drain.max_append_tx for is this commit alone.
            $this->draining->assertAccepting();

            return new AppendResult($locked->documentId, $update->generation, $update->updateId, $seq, $sha256, duplicate: false);
        });
    }

    /**
     * The checkpoint and the committed tail (C, H] of the document's current generation, read under the same locks an
     * append takes, so no append or publication lands between the parts.
     *
     * @throws NodeNotFoundException               the node is gone or in the trash
     * @throws CollaborationEpochMismatchException the generation is not the document's current one, or it was retired
     */
    public function snapshot(int|string $nodeId, int $generation): LogSnapshot
    {
        return $this->database->transaction(function () use ($nodeId, $generation): LogSnapshot {
            $locked = $this->state->lock($nodeId);
            if ($locked->trashed) {
                throw NodeNotFoundException::forId($nodeId);
            }
            $this->fence($locked, $generation);

            return $this->read($locked);
        });
    }

    /**
     * The checkpoint and the committed tail (C, H] of the locked document's current generation, read in the caller's
     * transaction, which took `$locked` with CollaborativeState::lock() (the compaction lease reads it so).
     *
     * @throws CollaborationEpochMismatchException the generation was retired
     */
    public function read(LockedDocumentState $locked): LogSnapshot
    {
        $this->compatibility->assert($locked->type, $locked->binding, $locked->collabState !== null);
        $head = $this->lockHead($locked, create: false);
        // The transaction began with a plain read (the node, in lock()): on MySQL (REPEATABLE READ) a plain read here
        // would answer from that older snapshot and miss an append committed since, while the head FOR UPDATE sees
        // it. A locking read sees the committed rows, as every read after the lock does on PostgreSQL
        // (the same split as NodeReadRepository::siblingQuery).
        $tail = $this->table('collaboration_updates')
            ->where('document_id', Identity::key($locked->documentId))
            ->where('generation', $locked->generation)
            ->where('seq', '>', $head['checkpoint_seq'])
            ->where('seq', '<=', $head['head_seq'])
            ->orderBy('seq')
            ->lockForUpdate()
            ->get(['seq', 'update_id', 'payload'])
            ->map(fn (object $row): array => [
                'seq' => self::int($row->seq),
                'update_id' => Identity::stringify($row->update_id),
                'payload' => $this->stored($row->payload),
            ])
            ->all();
        $tail = array_values($tail);

        return new LogSnapshot(
            documentId: $locked->documentId,
            generation: $locked->generation,
            stateVersion: $locked->stateVersion,
            type: $locked->type,
            schemaVersion: $locked->schemaVersion,
            content: $locked->content,
            checkpoint: $locked->collabState,
            checkpointSeq: $head['checkpoint_seq'],
            headSeq: $head['head_seq'],
            tail: $tail,
            binding: $locked->binding ?? throw new LogicException('Missing stored binding.'),
        );
    }

    /** The receipt of `$updateId` in the generation, if it was committed. */
    public function receipt(string $documentId, int $generation, string $updateId): ?Receipt
    {
        return $this->findReceipt($documentId, $generation, $updateId, lock: false);
    }

    /**
     * `$lock` makes it a locking read for a caller that holds the head lock: on MySQL (REPEATABLE READ) a plain read
     * would miss a receipt an append of the same id committed while this transaction waited for that lock (the same
     * split as NodeReadRepository::siblingQuery).
     */
    private function findReceipt(string $documentId, int $generation, string $updateId, bool $lock): ?Receipt
    {
        $query = $this->table('collaboration_receipts')
            ->where('document_id', Identity::key($documentId))
            ->where('generation', $generation)
            ->where('update_id', $updateId);
        if ($lock) {
            $query->lockForUpdate();
        }
        $row = $query->first(['seq', 'sha256']);

        return $row === null ? null : new Receipt($documentId, $generation, $updateId, self::int($row->seq), Identity::stringify($row->sha256));
    }

    /**
     * The drive's status read under the shared drive lock lock() holds, which an archive or a deletion takes
     * exclusively: one committed after the hub opened the room refuses the append here, so a new record never lands
     * after it (an archived drive is read-only, a drive being deleted is gone). A committed update still answers its
     * receipt above.
     *
     * @throws PermissionDeniedException the drive was archived
     * @throws NodeNotFoundException     the drive is being deleted or otherwise not usable
     */
    private function assertDriveWritable(LockedDocumentState $locked): void
    {
        $status = $locked->driveStatus;
        if ($status === DriveStatus::Archived) {
            throw PermissionDeniedException::forAbility(Ability::Edit->value);
        }
        if ($status !== DriveStatus::Active) {
            throw NodeNotFoundException::forId($locked->nodeId);
        }
    }

    /**
     * The hub's seed is the first record of a generation without checkpoint, built from the JSON of state version
     * `$expected`: another hub seeded first (a record or a checkpoint exists) or the JSON moved on since the hub loaded
     * it (a REST write while there is no Yjs state does not move the generation) — both refuse it, under the document lock and the head row lock.
     *
     * @param array{head_seq: int, checkpoint_seq: int} $head
     *
     * @throws CollaborationSeedConflictException
     */
    private function assertSeedable(LockedDocumentState $locked, array $head, int $expected): void
    {
        // The size column tells whether a checkpoint exists without reading it; a locking read, as in read().
        $checkpointed = $locked->collabStateSize !== null;
        if ($head['head_seq'] > 0 || $checkpointed) {
            throw new CollaborationSeedConflictException($locked->nodeId);
        }
        if ($locked->stateVersion !== $expected) {
            throw new CollaborationSeedConflictException($locked->nodeId, $expected, $locked->stateVersion);
        }
    }

    /** Under the document lock: only the document's current generation takes writes, and a retired one never again. */
    private function fence(LockedDocumentState $locked, int $generation): void
    {
        if ($generation !== $locked->generation) {
            throw new CollaborationEpochMismatchException(expected: $generation, actual: $locked->generation);
        }
    }

    /**
     * The head row of the locked document's generation FOR UPDATE. The first append of a generation creates it under
     * the document lock (which keeps a second creator out); a read without one sees an empty log.
     *
     * @return array{head_seq: int, checkpoint_seq: int}
     */
    private function lockHead(LockedDocumentState $locked, bool $create = true): array
    {
        $row = $this->heads($locked->documentId, $locked->generation)->lockForUpdate()->first(['head_seq', 'checkpoint_seq', 'retired_at']);
        if ($row === null && !$create) {
            return ['head_seq' => 0, 'checkpoint_seq' => 0];
        }
        if ($row === null) {
            $now = Carbon::now();
            $this->table('collaboration_heads')->insert([
                'document_id' => Identity::key($locked->documentId),
                'generation' => $locked->generation,
                'head_seq' => 0,
                'checkpoint_seq' => 0,
                'checkpoint_version' => $locked->stateVersion,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
            $row = $this->heads($locked->documentId, $locked->generation)->lockForUpdate()->first(['head_seq', 'checkpoint_seq', 'retired_at']);
            if ($row === null) {
                throw new LogicException('[Vaulter] The collaboration head was not created.');
            }
        }
        // A closed generation refuses every write, before and after its rows are pruned.
        if ($row->retired_at !== null) {
            throw new CollaborationEpochMismatchException(expected: $locked->generation, actual: $locked->generation);
        }

        return ['head_seq' => self::int($row->head_seq), 'checkpoint_seq' => self::int($row->checkpoint_seq)];
    }

    private function heads(string $documentId, int $generation): Builder
    {
        return $this->table('collaboration_heads')
            ->where('document_id', Identity::key($documentId))
            ->where('generation', $generation);
    }

    private function table(string $entity): Builder
    {
        return $this->database->connection()->table($this->tables->table($entity));
    }

    /** A counter column as the driver returns it (an int, or a numeric string on some drivers). */
    private static function int(mixed $value): int
    {
        return is_int($value) || (is_string($value) && is_numeric($value)) ? (int) $value : throw new LogicException('[Vaulter] A collaboration counter is not an integer.');
    }

    /** A stored payload as base64 text; PostgreSQL hands a bytea column out as a stream. */
    private function stored(mixed $value): string
    {
        if (is_resource($value)) {
            $value = stream_get_contents($value);
        }

        return is_string($value) ? $value : '';
    }
}
