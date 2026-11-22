<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Firebase\JWT\JWT;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use InvalidArgumentException;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Exceptions\CollaborationConfigException;
use Vaulter\Collaboration\Revocation\PermissionVersions;
use Vaulter\Support\Identity;
use Vaulter\ValueObjects\Access\ActorRef;

/**
 * Mints the room JWT of a session and of its renewals (HS256, the hub.jwt_active_kid key of hub.jwt_keys, named by the `kid` header). Claims: `iss` (hub.issuer), `aud`
 * (the hub), `sub` (the host user),
 * `document_id` (the document's node), `drive_id`, `tenant`, `generation` (the document's collab epoch),
 * `schema_version`, `scope` (`read`|`write`), `permissions_version` (`{drive, global}`, the versions it was
 * issued under), `room` (`<prefix>.<drive_id>.<document_id>.<generation>`), `iat` and `nbf` (the application clock), `protocol` (`yjs/2`), `exp` =
 * iat + hub.token_ttl and a fresh `jti`. The room repeats drive, document and generation, so a token is bound to
 * exactly one generation of one document; {@see CollaborationCallResolver} refuses a token whose claims disagree.
 */
#[Internal]
final readonly class RoomTokens
{
    public function __construct(
        private CollaborationOptions $config,
        private PermissionVersions $versions,
    ) {}

    /**
     * @throws CollaborationConfigException without a usable key set or issuer
     *
     * @return array{token: string, room: string, exp: int, jti: string, scope: string, permissions_version: array{drive: int, global: int}}
     */
    public function mint(ActorRef $principal, string $documentId, string $driveId, ?string $tenant, int $generation, int $schemaVersion, bool $writable, string $protocol, string $stateFormat, int $notAfter): array
    {
        $violation = $this->config->hubJwtKeysViolation();
        $kid = $this->config->hubJwtActiveKid();
        $secret = $this->config->hubJwtSigningKey();
        if ($violation !== null || $kid === null || $secret === null) {
            throw CollaborationConfigException::missingSecret();
        }
        $issuer = $this->config->hubIssuer() ?? throw CollaborationConfigException::missingIssuer();
        $room = $this->config->room($driveId, $documentId, $generation);
        $scope = $writable ? CollaborationCall::SCOPE_WRITE : CollaborationCall::SCOPE_READ;
        $version = $this->versions->current($driveId)->toClaim();
        $issuedAt = Carbon::now()->getTimestamp();
        $exp = min($issuedAt + $this->config->hubTokenTtl(), $notAfter);
        if ($principal->type === null || $principal->type === ActorRef::SYSTEM_TYPE || $principal->id === null
            || $protocol !== 'yjs' || $stateFormat === '' || $schemaVersion < 1 || $generation < 0 || $exp <= $issuedAt) {
            throw new InvalidArgumentException('[Vaulter] A room credential needs a live grant and complete user and state identities.');
        }
        $jti = (string) Str::uuid();

        $token = JWT::encode(
            payload: [
                'iss' => $issuer,
                'aud' => CollaborationOptions::JWT_AUDIENCE,
                'sub' => Identity::stringify($principal->id),
                'sub_type' => $principal->type,
                'protocol' => CollaborationOptions::JWT_PROTOCOL,
                'state_format' => $stateFormat,
                'document_id' => $documentId,
                'drive_id' => $driveId,
                'tenant' => $tenant,
                'generation' => $generation,
                'schema_version' => $schemaVersion,
                'scope' => $scope,
                'permissions_version' => $version,
                'room' => $room,
                'iat' => $issuedAt,
                'nbf' => $issuedAt,
                'exp' => $exp,
                'jti' => $jti,
            ],
            key: $secret->reveal(),
            alg: 'HS256',
            keyId: $kid,
        );

        return ['token' => $token, 'room' => $room, 'exp' => $exp, 'jti' => $jti, 'scope' => $scope, 'permissions_version' => $version];
    }
}
