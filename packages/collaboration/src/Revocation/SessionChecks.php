<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\CollaborationCall;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\CollaborationHub;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\RoomTokens;
use Vaulter\Contracts\Observability\MetricsRecorder;
use Vaulter\Documents\Exceptions\CollaborationUnavailableException;
use Vaulter\Documents\Exceptions\NotADocumentException;
use Vaulter\Drive\Enums\Access\Ability;
use Vaulter\Drive\Exceptions\Access\PermissionDeniedException;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;

/**
 * The two checks of a live session's rights the hub asks for: the renewal of one connection's token before it
 * expires, and the batch recheck of the connections of a drive after a control message. Both open the room exactly as
 * every hub call does ({@see CollaborationHub::open()}): the document, its generation, its drive and the subject's
 * rights now. A renewal therefore never extends authority the subject lost: write without Edit any more is renewed
 * read-only, without View it is refused, and the new token expires `hub.token_ttl` from now while the old one keeps
 * its own exp.
 */
#[Internal]
final readonly class SessionChecks
{
    /** The most connections one recheck may name. */
    public const int MAX_RECHECK = 200;

    public const string ACCESS_NONE = 'none';

    public const string ACCESS_READ = 'read';

    public const string ACCESS_WRITE = 'write';

    public function __construct(
        private CollaborationHub $hub,
        private RoomTokens $tokens,
        private CollaborationCallResolver $resolver,
        private MetricsRecorder $metrics,
    ) {}

    /**
     * A new token for the connection of `$call`, scoped by the rights now.
     *
     *
     * @throws PermissionDeniedException           the subject no longer holds View, or the body names another room
     * @throws NodeNotFoundException               the document is gone, trashed or no longer usable
     * @throws CollaborationEpochMismatchException the document moved to another generation
     * @throws CollaborationUnavailableException   the type cannot collaborate
     *
     * @return array{token: string, room: string, generation: int, scope: string, mode: string, exp: int, jti: string, permissions_version: array{drive: int, global: int}}
     */
    public function renew(CollaborationCall $call, mixed $room): array
    {
        $opened = $this->hub->open($call, $room);
        if ($opened->ability === null) {
            $this->metrics->counter(name: 'vaulter_collab_token_renewals_total', labels: ['outcome' => 'denied']);

            throw PermissionDeniedException::forAbility(Ability::View->value);
        }

        $minted = $this->tokens->mint(
            principal: $opened->grant->principal,
            documentId: $call->ref->nodeId,
            driveId: $call->ref->driveId,
            tenant: $call->tenant,
            generation: $call->ref->epoch,
            schemaVersion: $call->schemaVersion,
            writable: $opened->writable,
            protocol: $opened->grant->protocol,
            stateFormat: $opened->grant->stateFormat,
            notAfter: $opened->grant->notAfter,
        );
        $this->metrics->counter(name: 'vaulter_collab_token_renewals_total', labels: ['outcome' => $minted['scope']]);

        return [
            'token' => $minted['token'],
            'room' => $minted['room'],
            'generation' => $call->ref->epoch,
            'scope' => $minted['scope'],
            'mode' => $opened->mode(),
            'exp' => $minted['exp'],
            'jti' => $minted['jti'],
            'permissions_version' => $minted['permissions_version'],
        ];
    }

    /**
     * What each named connection may do now: `none` (close it), `read` (read-only) or `write`. `reason` says why a
     * connection lost everything: `token` (invalid or expired), `gone` (the document is not there or not usable),
     * `generation` (the document moved on), `unavailable` (its type cannot collaborate) or `revoked` (no View).
     *
     * @param  list<array{id: string, token: string}>                                         $connections
     * @return list<array{id: string, access: string, reason: string|null, jti: string|null}>
     */
    public function recheck(array $connections): array
    {
        $results = [];
        foreach ($connections as $connection) {
            $results[] = ['id' => $connection['id'], ...$this->access($connection['token'])];
        }
        $this->metrics->counter(name: 'vaulter_collab_rechecks_total', amount: count($results));

        return $results;
    }

    /** @return array{access: string, reason: string|null, jti: string|null} */
    private function access(string $token): array
    {
        $call = $this->resolver->verifyToken($token);
        if (!$call instanceof CollaborationCall) {
            return ['access' => self::ACCESS_NONE, 'reason' => 'token', 'jti' => null];
        }

        try {
            $room = $this->hub->open($call, $call->room);
        } catch (CollaborationEpochMismatchException) {
            return ['access' => self::ACCESS_NONE, 'reason' => 'generation', 'jti' => $call->jti];
        } catch (CollaborationUnavailableException) {
            return ['access' => self::ACCESS_NONE, 'reason' => 'unavailable', 'jti' => $call->jti];
        } catch (NodeNotFoundException|NotADocumentException|PermissionDeniedException) {
            return ['access' => self::ACCESS_NONE, 'reason' => 'gone', 'jti' => $call->jti];
        }

        return match (true) {
            $room->ability === null => ['access' => self::ACCESS_NONE, 'reason' => 'revoked', 'jti' => $call->jti],
            $room->writable => ['access' => self::ACCESS_WRITE, 'reason' => null, 'jti' => $call->jti],
            default => ['access' => self::ACCESS_READ, 'reason' => null, 'jti' => $call->jti],
        };
    }
}
