<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\Exceptions\CollaborationSeedConflictException;
use Vaulter\Collaboration\Persistence\AppendResult;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Revocation\PermissionVersions;
use Vaulter\Documents\Access\CollaborationAccessPolicy;
use Vaulter\Documents\Data\Collaboration\CollaborationAccessDecision;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Exceptions\CollaborationUnavailableException;
use Vaulter\Documents\Exceptions\NotADocumentException;
use Vaulter\Documents\Types\DocumentTypeRegistry;
use Vaulter\Drive\Enums\Access\Ability;
use Vaulter\Drive\Exceptions\Access\PermissionDeniedException;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Support\Identity;
use Vaulter\ValueObjects\Access\Actor;

/**
 * The server side of the hub's protocol 2 calls on behalf of a room connection (authenticate, load, append). They
 * carry no user session — a room JWT and a body signature (ResolveCollaborationCall) — so they cannot go through
 * DocumentOperations; instead every call re-reads what the token was issued for: the node still exists, is not in the
 * trash, belongs to the token's drive and tenant, the drive is active (archived: read-only), the room's epoch is the
 * document's current one, and the token subject's rights now. A revoked Edit therefore takes effect on the hub's next
 * call, whatever the permission versions say; a token older than its drive's or the global permission version
 * is marked stale, so the hub renews it at once.
 */
#[Internal]
final readonly class CollaborationHub
{
    public function __construct(
        private DocumentTypeRegistry $types,
        private CollaborationAccessPolicy $policy,
        private HostUserResolver $users,
        private UpdateLog $log,
        private PermissionVersions $versions,
    ) {}

    /**
     * The live room a call addresses.
     *
     * @throws PermissionDeniedException           the body names another room than the token
     * @throws NodeNotFoundException               gone, trashed, moved to another drive/tenant, the drive is not usable,
     *                                             or the subject cannot see a document whose generation moved
     * @throws CollaborationEpochMismatchException the document moved to another generation (a subject with View)
     * @throws CollaborationUnavailableException   the type cannot collaborate
     * @throws NotADocumentException               the node is not a document
     */
    public function open(CollaborationCall $call, mixed $room): HubRoom
    {
        $actor = $this->actor($call, $room);
        $ref = $call->ref;
        $decision = $this->policy->evaluateReference(
            $actor, $ref->driveId, $ref->nodeId, $call->tenant, $call->jti,
            ceiling: $call->mayStore() ? CollaborationMode::Write : CollaborationMode::Read,
            clientSchemaVersion: $call->schemaVersion,
        );

        return $this->checkedRoom($call, $decision);
    }

    /** @internal A valid room reference whose actor lost View authenticates as denied, without a grant. */
    #[Internal]
    public function authenticate(CollaborationCall $call, mixed $room): ?HubRoom
    {
        $actor = $this->actor($call, $room);
        $ref = $call->ref;
        $decision = $this->policy->evaluateAuthenticationReference(
            $actor, $ref->driveId, $ref->nodeId, $call->tenant, $call->jti,
            ceiling: $call->mayStore() ? CollaborationMode::Write : CollaborationMode::Read,
            clientSchemaVersion: $call->schemaVersion,
        );

        return $decision === null ? null : $this->checkedRoom($call, $decision);
    }

    /** Validate the requested room and the complete principal before consulting document authority. */
    private function actor(CollaborationCall $call, mixed $room): Actor
    {
        if (!is_string($room) || $room !== $call->room) {
            throw PermissionDeniedException::forAbility(Ability::View->value);
        }

        $ref = $call->ref;
        $actor = $this->users->find($call->principal);
        if ($actor === null) {
            throw NodeNotFoundException::forId($ref->nodeId);
        }
        $resolved = Actor::user($actor);
        if ($resolved->ref()->type !== $call->principal->type
            || Identity::stringify($resolved->ref()->id) !== Identity::stringify($call->principal->id)) {
            throw NodeNotFoundException::forId($ref->nodeId);
        }

        return $resolved;
    }

    /** The generation and binding fences are identical for every authorized hub call. */
    private function checkedRoom(CollaborationCall $call, CollaborationAccessDecision $decision): HubRoom
    {
        $ref = $call->ref;
        $grant = $decision->grant;
        if ($grant->generation !== $ref->epoch) {
            throw new CollaborationEpochMismatchException(expected: $ref->epoch, actual: $grant->generation);
        }
        if ($grant->protocol !== $call->protocol || $grant->stateFormat !== $call->stateFormat || $grant->schemaVersion !== $call->schemaVersion) {
            throw new CollaborationUnavailableException('unsupported_binding', $grant->documentType);
        }

        return new HubRoom(
            type: $this->types->find($grant->documentType),
            ability: $decision->ability,
            writable: $grant->mode === CollaborationMode::Write,
            driveActive: $decision->driveActive,
            userId: Identity::stringify($call->principal->id),
            grant: $grant,
            permissionsStale: $call->permissionsVersion->olderThan($this->versions->current($ref->driveId)),
        );
    }

    /**
     * Protocol 2: append one update of the room's generation to the document's log. Only a writable room appends; a
     * subject who cannot see the document gets the same 404 as a document that does not exist. The seed (an update
     * with a seed state version) is appended only as the first record of a generation without checkpoint.
     *
     * @throws NodeNotFoundException               the subject cannot see the document (or it is gone)
     * @throws PermissionDeniedException           the room may not write now
     * @throws CollaborationEpochMismatchException the update is of another generation than the room's or the document's
     * @throws CollaborationSeedConflictException  a seed over a log that is no longer empty, or over newer JSON
     */
    public function append(HubRoom $room, CollaborationCall $call, UpdateEnvelope $update): AppendResult
    {
        $this->assertVisible($room, $call);
        if (!$room->writable) {
            throw PermissionDeniedException::forAbility(Ability::Edit->value);
        }
        if ($update->generation !== $call->ref->epoch) {
            throw new CollaborationEpochMismatchException(expected: $update->generation, actual: $room->grant->generation);
        }

        return $this->log->append($call->ref->nodeId, $update, function () use ($call): void {
            // UpdateLog invokes this after T → N → D locks, inside the append transaction.
            $current = $this->open($call, $call->room);
            if (!$current->writable) {
                throw PermissionDeniedException::forAbility(Ability::Edit->value);
            }
        });
    }

    /**
     * Protocol 2 load: the checkpoint and the committed tail (C, H] the hub replays, read together under the document
     * and head locks. Before the first checkpoint there is no binary state: the log's first record is the hub's seed,
     * and while the generation has no record yet, the JSON projection, read through the type, is what the hub builds the
     * seed from (appended with `seed_state_version` = this `state_version`).
     *
     * @return array{generation: int, schema_version: int, type: string, state_version: int, checkpoint: string|null, checkpoint_seq: int, head_seq: int, content: array<string, mixed>|null, tail: list<array{seq: int, update_id: string, payload: string}>}
     */
    public function loadLog(HubRoom $room, CollaborationCall $call): array
    {
        $this->assertVisible($room, $call);
        $log = $this->log->snapshot($call->ref->nodeId, $call->ref->epoch);

        // Everything below comes from the locked snapshot, not from the room open() read before the locks: a write
        // between the two would pair one moment's content with another's state version.
        return [
            'generation' => $log->generation,
            'schema_version' => $log->binding->schemaVersion,
            'protocol' => $log->binding->protocol,
            'state_format' => $log->binding->stateFormat,
            'type' => $log->type,
            'state_version' => $log->stateVersion,
            'checkpoint' => $log->checkpoint === null ? null : base64_encode($log->checkpoint),
            'checkpoint_seq' => $log->checkpointSeq,
            'head_seq' => $log->headSeq,
            'content' => $log->checkpoint === null
                ? $log->content
                : null,
            'tail' => $log->tail,
        ];
    }

    /** A subject without View learns nothing a missing document would not tell (protocol 2 calls). */
    private function assertVisible(HubRoom $room, CollaborationCall $call): void
    {
        if ($room->ability === null) {
            throw NodeNotFoundException::forId($call->ref->nodeId);
        }
    }
}
