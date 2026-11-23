<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\Persistence\Head;
use Vaulter\Collaboration\Persistence\LogTables;
use Vaulter\Collaboration\Persistence\RoomWriteConflict;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\Contracts\SupportsCollaboration;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Exceptions\CollaborationUnavailableException;
use Vaulter\Documents\State\LockedDocumentState;
use Vaulter\Documents\Types\DocumentTypeRegistry;
use Vaulter\Drive\Enums\DriveStatus;
use Vaulter\Kernel;
use Vaulter\Support\Identity;

/** Checks generation ownership and resolves the journal protocol from the locked document's registered driver. */
#[Spi(SpiKind::Call)]
final readonly class RoomOwnership
{
    #[Internal]
    public function __construct(private DocumentTypeRegistry $types, private Kernel $kernel, private LogTables $log) {}

    /** Select a profile when the new generation first obtains a head under the document lock. */
    #[Internal]
    public function selectProfile(LockedDocumentState $document, bool $strict, ?string $nativeProtocol = null): Head
    {
        $head = $this->head($document);
        if ($head !== null) {
            return $head;
        }
        $protocol = $this->protocol($document);
        $supportsTenant = $document->tenantId === null || (string) (int) $document->tenantId === $document->tenantId;
        $profile = $strict && (($supportsTenant && $protocol === 'yjs/2') || $protocol === $nativeProtocol)
            && $document->writeMode === 'journal' ? 'strict' : 'standard';
        $now = $this->log->leaseClock();
        $this->log->table('collaboration_heads')->insert([
            'document_id' => Identity::key($document->documentId),
            'generation' => $document->generation,
            'protocol' => $protocol,
            'profile' => $profile,
            'head_seq' => 0,
            'checkpoint_seq' => 0,
            'checkpoint_version' => $document->stateVersion,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->head($document) ?? throw new \LogicException('The collaboration head was not created.');
    }

    #[Internal]
    public function head(LockedDocumentState $document): ?Head
    {
        $head = $this->log->lockHead($document->documentId, $document->generation);
        if ($head?->retiredAt !== null) {
            throw new CollaborationEpochMismatchException(expected: $document->generation, actual: $document->generation);
        }
        if ($head !== null && $head->protocol !== $this->protocol($document)) {
            throw new CollaborationUnavailableException('unsupported_binding', $document->type);
        }

        return $head;
    }

    #[Internal]
    public function acquire(LockedDocumentState $document, string $ownerId): Head
    {
        $head = $this->strictHead($document);
        $now = $this->log->leaseClock();
        if ($head->ownerExpiresAt?->greaterThan($now)) {
            if ($head->ownerId !== $ownerId) {
                throw new RoomWriteConflict('owner_busy');
            }

            return $head;
        }

        return $this->setOwner($document, $ownerId, $head->ownerFence + 1, $now->addSeconds(15));
    }

    #[Internal]
    public function renew(LockedDocumentState $document, string $ownerId, int $fence): Head
    {
        $this->assertOwner($document, $ownerId, $fence);

        return $this->setOwner($document, $ownerId, $fence, $this->log->leaseClock()->addSeconds(15));
    }

    #[Internal]
    public function release(LockedDocumentState $document, string $ownerId, int $fence): void
    {
        $head = $this->assertOwner($document, $ownerId, $fence);
        $this->setOwner($document, null, $fence, null);
        if ($head->checkpointSeq < $head->headSeq) {
            $this->log->rows('collaboration_heads', $document->documentId, $document->generation)->update([
                'drain_requested_at' => $this->log->leaseClock(),
            ]);
        }
    }

    #[Internal]
    public function assertOwner(LockedDocumentState $document, string $ownerId, int $fence): Head
    {
        $head = $this->strictHead($document);
        if ($fence < 1 || $head->ownerFence !== $fence || $head->ownerId !== $ownerId
            || !$head->ownerExpiresAt?->greaterThan($this->log->leaseClock())) {
            throw new RoomWriteConflict('stale_owner');
        }

        return $head;
    }

    #[Internal]
    public function strictHead(LockedDocumentState $document): Head
    {
        $head = $this->head($document);
        if ($head === null || $head->profile !== 'strict' || $document->writeMode !== 'journal'
            || $document->trashed || $document->driveStatus !== DriveStatus::Active) {
            throw new RoomWriteConflict('strict_profile_required');
        }

        return $head;
    }

    /** Allocate once per browser document, retaining the binding across token renewals and process handoff. */
    #[Internal]
    public function bindBrowser(LockedDocumentState $document, int $tenant, string $subject, string $session): int
    {
        $this->strictHead($document);
        $row = $this->clientIds($document)->where('session_id', $session)->first(['client_id', 'tenant_id', 'effective_subject', 'writer_kind']);
        if ($row !== null) {
            if ($row->writer_kind !== 'browser' || LogTables::int($row->tenant_id) !== $tenant || $row->effective_subject !== $subject) {
                throw new RoomWriteConflict('client_id_conflict');
            }

            return LogTables::int($row->client_id);
        }
        do {
            $id = random_int(0x80000000, 0xFFFFFFFF);
        } while ($this->clientIds($document)->where('client_id', $id)->exists());
        $this->insertClientId($document, $id, $tenant, 'browser', $subject, $session);

        return $id;
    }

    #[Internal]
    public function assertBrowser(LockedDocumentState $document, int $tenant, string $subject, string $session, int $id): void
    {
        if ($id < 0x80000000 || !$this->clientIds($document)->where([
            'tenant_id' => $tenant, 'effective_subject' => $subject, 'session_id' => $session, 'client_id' => $id, 'writer_kind' => 'browser',
        ])->exists()) {
            throw new RoomWriteConflict('client_id_conflict');
        }
    }

    /** @param list<int> $historical */
    #[Internal]
    public function allocateServer(LockedDocumentState $document, int $tenant, string $owner, array $historical): int
    {
        foreach ($historical as $id) {
            $this->insertClientId($document, $id, $tenant, 'historical', null, null);
        }
        $existing = $this->clientIds($document)->where(['writer_kind' => 'server', 'session_id' => $owner])->value('client_id');
        if ($existing !== null) {
            return LogTables::int($existing);
        }
        $id = LogTables::int($this->clientIds($document)->where('writer_kind', 'server')->max('client_id') ?? 0);
        do {
            if (++$id >= 0x80000000) {
                throw new RoomWriteConflict('client_ids_exhausted');
            }
        } while ($this->clientIds($document)->where('client_id', $id)->exists());
        $this->insertClientId($document, $id, $tenant, 'server', $owner, $owner);

        return $id;
    }

    private function clientIds(LockedDocumentState $document): Builder
    {
        return $this->log->rows('collaboration_client_ids', $document->documentId, $document->generation);
    }

    private function insertClientId(LockedDocumentState $document, int $id, int $tenant, string $kind, ?string $subject, ?string $session): void
    {
        $table = $this->log->table('collaboration_client_ids');
        $row = [
            'document_id' => Identity::key($document->documentId),
            'generation' => $document->generation,
            'client_id' => $id,
            'tenant_id' => $tenant,
            'writer_kind' => $kind,
            'effective_subject' => $subject,
            'session_id' => $session,
        ];
        if ($kind === 'historical') {
            $table->insertOrIgnore($row);
        } else {
            $table->insert($row);
        }
    }

    private function setOwner(LockedDocumentState $document, ?string $owner, int $fence, ?Carbon $expires): Head
    {
        $this->log->rows('collaboration_heads', $document->documentId, $document->generation)->update([
            'owner_id' => $owner,
            'owner_fence' => $fence,
            'owner_expires_at' => $expires === null ? null : $this->log->timestamp($expires),
        ]);

        return $this->strictHead($document);
    }

    public function assertGeneration(LockedDocumentState $document, int $generation): void
    {
        if ($generation !== $document->generation) {
            throw new CollaborationEpochMismatchException(expected: $generation, actual: $document->generation);
        }
    }

    public function protocol(LockedDocumentState $document): string
    {
        $binding = $document->binding;
        $type = $this->types->find($document->type);
        $extensions = $this->kernel->extensions();
        if (!$type instanceof SupportsCollaboration || $binding === null
            || $type->collaborationProtocol() !== $binding->protocol
            || $type->collaborationStateFormat() !== $binding->stateFormat
            || !in_array($binding->protocol, $extensions->handlerKeys(CollaborationProtocolDriver::class), true)) {
            throw new CollaborationUnavailableException('unsupported_binding', $document->type);
        }
        $driver = $extensions->handler(CollaborationProtocolDriver::class, $binding->protocol);
        if ($driver->protocol() !== $binding->protocol
            || !$driver->supportsState($document->type, $binding->stateFormat, $binding->schemaVersion, $document->collabState !== null, CollaborationMode::Read)) {
            throw new CollaborationUnavailableException('unsupported_binding', $document->type);
        }
        $protocol = $driver->version();
        if (!str_starts_with($protocol, $binding->protocol.'/') || !self::isProtocolVersion($protocol)) {
            throw new CollaborationUnavailableException('unsupported_binding', $document->type);
        }

        return $protocol;
    }

    #[Internal]
    public static function isProtocolVersion(string $protocol): bool
    {
        return strlen($protocol) <= 64 && preg_match('/\A[a-z][a-z0-9-]*\/[1-9][0-9]*\z/', $protocol) === 1;
    }
}
