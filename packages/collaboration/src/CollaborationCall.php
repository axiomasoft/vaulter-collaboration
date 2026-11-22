<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\Data\RoomRef;
use Vaulter\Collaboration\Http\Middleware\ResolveCollaborationCall;
use Vaulter\Collaboration\Revocation\PermissionVersion;
use Vaulter\ValueObjects\Access\ActorRef;

/**
 * The verified room token of a hub call, resolved by {@see CollaborationCallResolver} and stashed by
 * {@see ResolveCollaborationCall}. Every claim was signed by this application; the hub only relays the token its
 * client presented.
 *
 *   - room/ref           — the room the token was minted for and its drive/document/generation.
 *   - subject            — the host user the hub attributes the call to.
 *   - mode               — 'rw' (scope `write`) or 'ro' (scope `read`) at the time the token was issued; the hub
 *                          endpoints re-check it against the live document and rights.
 *   - schemaVersion      — the schema the session was issued for.
 *   - tenant             — the node's tenant when the token was issued, or null.
 *   - permissionsVersion — the drive and global permission versions it was issued under.
 *   - jti, expiresAt     — the token's id and exp.
 */
#[Internal]
final readonly class CollaborationCall
{
    public const string SCOPE_READ = 'read';

    public const string SCOPE_WRITE = 'write';

    public function __construct(
        public string $room,
        public RoomRef $ref,
        public ActorRef $principal,
        public string $protocol,
        public string $stateFormat,
        public string $mode,
        public int $schemaVersion,
        public ?string $tenant,
        public PermissionVersion $permissionsVersion,
        public string $jti,
        public int $expiresAt,
    ) {}

    /** A read-only token never drives a write, whatever the live rights are. */
    public function mayStore(): bool
    {
        return $this->mode === 'rw';
    }
}
