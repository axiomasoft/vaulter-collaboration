<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Exceptions\CollaborationCheckpointConflictException;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Contracts\Observability\MetricsRecorder;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Exceptions\DocumentContentDegradedException;
use Vaulter\Documents\Exceptions\DocumentTypeUnavailableException;
use Vaulter\Documents\Exceptions\InvalidDocumentContentException;
use Vaulter\Documents\Exceptions\NotADocumentException;
use Vaulter\Documents\State\CheckpointPublication;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Support\LoadTier;

/**
 * The publication of a checkpoint the hub merged under a compaction lease, as one compare-and-set under the
 * document lock (CollaborativeState::lock()) and the head row FOR UPDATE: the generation is the document's current
 * one and open, the lease token is the one that holds it, the checkpoint the merge started from is still the last one
 * (CS == C, CV == the document's state version) and the covered range is in the log (C ≤ H ≤ HS). The documents
 * contract then publishes the state and clears the marker only when H covers it.
 *
 * In the same transaction the payloads of the generation through H are deleted, the head moves to (H, the new state
 * version) and the lease is spent. Receipts stay until the prune of the retired generation. A publication that
 * loses changes and deletes nothing.
 */
#[Internal]
final readonly class Checkpoint
{
    public function __construct(
        private VaulterDatabase $database,
        private LogTables $log,
        private CollaborativeState $state,
        private MetricsRecorder $metrics,
        private YjsStateCompatibility $compatibility,
    ) {}

    /**
     * @throws NodeNotFoundException                    the document is gone
     * @throws NotADocumentException                    the node is not a document
     * @throws CollaborationEpochMismatchException      the generation is not the document's current one, or it was retired
     * @throws CollaborationCheckpointConflictException the lease does not hold the generation, or the log moved since it was read
     * @throws DocumentTypeUnavailableException         the document's type is not installed
     * @throws DocumentContentDegradedException         the working state reads only partly under its type
     * @throws InvalidDocumentContentException          the type rejects the projection
     */
    public function publish(CheckpointRequest $request): CheckpointResult
    {
        // The snapshot of the document's state is written here (the full-state store is gone): its duration is the one
        // vaulter_collab_snapshot_duration_seconds measures.
        return $this->metrics->timing(
            name: 'vaulter_collab_snapshot_duration_seconds',
            operation: fn (): CheckpointResult => $this->transaction($request),
            labels: ['tier' => LoadTier::label()],
        );
    }

    private function transaction(CheckpointRequest $request): CheckpointResult
    {
        return $this->database->transaction(function () use ($request): CheckpointResult {
            $locked = $this->state->lock($request->nodeId);
            if ($request->generation !== $locked->generation) {
                throw new CollaborationEpochMismatchException(expected: $request->generation, actual: $locked->generation);
            }
            if ($locked->binding === null || !$request->binding->sameAs($locked->binding) || $request->documentType !== $locked->type) {
                throw new CollaborationCheckpointConflictException(CollaborationCheckpointConflictException::VERSION);
            }
            $this->compatibility->assert($locked->type, $locked->binding, $locked->collabState !== null);
            $now = Carbon::now();
            $head = $this->log->lockHead($locked->documentId, $locked->generation);
            if ($head?->retiredAt !== null) {
                throw new CollaborationEpochMismatchException(expected: $request->generation, actual: $locked->generation);
            }
            if ($head === null || !$head->heldBy($request->leaseToken, $now)
                || !LeaseBinding::matches($request->leaseToken, $locked->documentId, $request->documentType, $request->binding, $head->checkpointVersion)) {
                throw new CollaborationCheckpointConflictException(CollaborationCheckpointConflictException::LEASE);
            }
            if ($request->coveredFrom !== $head->checkpointSeq || $request->coveredThrough < $request->coveredFrom || $request->coveredThrough > $head->headSeq) {
                throw new CollaborationCheckpointConflictException(CollaborationCheckpointConflictException::COVERAGE);
            }
            if ($request->expectedCheckpointVersion !== $head->checkpointVersion || $head->checkpointVersion !== $locked->stateVersion) {
                throw new CollaborationCheckpointConflictException(CollaborationCheckpointConflictException::VERSION);
            }

            $outcome = $this->state->publishCheckpoint($locked, new CheckpointPublication(
                binding: $request->binding,
                expectedStateVersion: $head->checkpointVersion,
                coveredThrough: $request->coveredThrough,
                collabState: $request->state,
                content: $request->content,
            ));
            if (!$outcome->published) {
                throw new CollaborationCheckpointConflictException(CollaborationCheckpointConflictException::VERSION);
            }

            // Only the payloads this checkpoint covers go, and only of its generation; every receipt stays.
            $this->log->rows('collaboration_updates', $locked->documentId, $locked->generation)
                ->where('seq', '<=', $request->coveredThrough)
                ->delete();
            $markerCleared = $outcome->pending === null;
            $this->log->rows('collaboration_heads', $locked->documentId, $locked->generation)->update([
                'checkpoint_seq' => $request->coveredThrough,
                'checkpoint_version' => $outcome->stateVersion,
                'lease_token' => null,
                'lease_owner' => null,
                'lease_expires_at' => null,
                // A drain is answered once the marker is gone; edits committed past H keep it asked for.
                ...($markerCleared ? ['drain_requested_at' => null] : []),
                'updated_at' => $now,
            ]);

            return new CheckpointResult(checkpointVersion: $outcome->stateVersion, markerCleared: $markerCleared);
        });
    }
}
