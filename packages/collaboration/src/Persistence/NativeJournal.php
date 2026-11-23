<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Internal;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use Vaulter\Collaboration\Drain\DrainState;
use Vaulter\Collaboration\RoomOwnership;
use Vaulter\Documents\State\CheckpointPublication;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\LockedDocumentState;

/** Fenced synchronous journal for native adapters. The caller authorizes and holds the Documents lock in its transaction. */
#[Spi(SpiKind::Call)]
final readonly class NativeJournal
{
    #[Internal]
    public function __construct(
        private RoomOwnership $rooms,
        private UpdateLog $updates,
        private LogTables $tables,
        private CollaborativeState $state,
        private DrainState $draining,
    ) {}

    public function initialize(LockedDocumentState $document, string $protocol): void
    {
        $this->draining->assertAccepting();
        if ($protocol === 'yjs/2' || $document->writeMode !== 'journal' || $this->rooms->protocol($document) !== $protocol) {
            throw new RoomWriteConflict('unsupported_protocol');
        }
        $this->rooms->selectProfile($document, strict: true, nativeProtocol: $protocol);
        $this->rooms->strictHead($document);
    }

    /** @return array{owner_fence: int, head_seq: int, owner_expires_at: string|null} */
    public function acquire(LockedDocumentState $document, string $owner): array
    {
        return $this->lease($this->rooms->acquire($document, $owner));
    }

    /** @return array{owner_fence: int, head_seq: int, owner_expires_at: string|null} */
    public function renew(LockedDocumentState $document, string $owner, int $fence): array
    {
        return $this->lease($this->rooms->renew($document, $owner, $fence));
    }

    public function release(LockedDocumentState $document, string $owner, int $fence): void
    {
        $this->rooms->release($document, $owner, $fence);
    }

    public function assertOwner(LockedDocumentState $document, string $owner, int $fence): int
    {
        return $this->rooms->assertOwner($document, $owner, $fence)->headSeq;
    }

    public function snapshot(LockedDocumentState $document): LogSnapshot
    {
        return $this->updates->read($document);
    }

    /** Append a physical update and record the covering checkpoint before returning its Documents position. */
    public function append(LockedDocumentState $document, string $owner, int $fence, int $base, UpdateEnvelope $update, CheckpointPublication $checkpoint): int
    {
        $this->draining->assertAccepting();
        $head = $this->rooms->assertOwner($document, $owner, $fence);
        if ($head->headSeq !== $base || $checkpoint->coveredThrough !== $base + 1 || $head->checkpointSeq !== $base) {
            throw new RoomWriteConflict('base_moved');
        }
        $this->updates->writeLocked($document, $base, $update, $base, allowDuplicate: false);
        $outcome = $this->state->publishCheckpoint($document, $checkpoint);
        if (!$outcome->published || $outcome->pending !== null) {
            throw new RoomWriteConflict('checkpoint_moved');
        }
        $this->rooms->assertOwner($document, $owner, $fence);
        $this->tables->rows('collaboration_heads', $document->documentId, $document->generation)->update([
            'checkpoint_seq' => $checkpoint->coveredThrough,
            'checkpoint_version' => $outcome->stateVersion,
        ]);
        $this->draining->assertAccepting();

        return $outcome->stateVersion;
    }

    /** @return array{owner_fence: int, head_seq: int, owner_expires_at: string|null} */
    private function lease(Head $head): array
    {
        return ['owner_fence' => $head->ownerFence, 'head_seq' => $head->headSeq, 'owner_expires_at' => $head->ownerExpiresAt?->toISOString()];
    }
}
