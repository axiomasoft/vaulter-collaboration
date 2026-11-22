<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Drain;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Persistence\CompactionLeases;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\PendingMarker;
use Vaulter\Documents\State\PendingStateDrainer;

/**
 * The documents' PendingStateDrainer on the hub: PHP does not merge Yjs, so a drain asks the hub's compaction
 * worker for a checkpoint and waits for it. A short transaction of its own sets drain_requested_at, which makes the
 * generation the first the next compaction lease hands out; then, outside any transaction, the {@see DrainWaiter} polls
 * the document's marker until it is gone or `vaulter-collaboration.drain.restore_deadline` passed.
 *
 * The outcome is what documents reads afterwards under its own locks, never the return: a marker still set (the hub is
 * down, the deadline passed, edits kept coming) answers 409 document_state_pending, the generation stays and no receipt
 * is lost. Inside a transaction it does nothing: no lock is held while the hub works.
 */
#[Internal]
final readonly class HubDrainer implements PendingStateDrainer
{
    public function protocol(): string
    {
        return 'yjs';
    }

    public function __construct(
        private VaulterDatabase $database,
        private CollaborativeState $state,
        private CompactionLeases $leases,
        private DrainWaiter $waiter,
        private CollaborationOptions $config,
    ) {}

    public function drain(PendingMarker $marker): void
    {
        if ($this->database->connection()->transactionLevel() > 0 || !$this->leases->requestDrain($marker)) {
            return;
        }

        $this->waiter->wait($marker, fn (): bool => $this->settled($marker), $this->config->restoreDeadline());
    }

    /** Whether the document no longer carries a marker of the drained generation; a plain read between the polls. */
    private function settled(PendingMarker $marker): bool
    {
        // Between the polls no lock is held: each read is a short transaction of its own, and a document that is gone or
        // addressed by another aggregate settles it.
        $current = $this->database->transaction(fn (): ?PendingMarker => $this->state->lockByDocumentId($marker->documentId)?->pending);

        return $current === null || $current->generation !== $marker->generation;
    }
}
