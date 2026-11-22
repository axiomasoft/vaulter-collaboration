<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Controllers\Collaboration;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\CollaborationHub;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Exceptions\CollaborationUpdateTooLargeException;
use Vaulter\Collaboration\Http\Middleware\LimitHubAppend;
use Vaulter\Collaboration\Http\Middleware\ResolveCollaborationCall;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;

/**
 * Protocol 2 append: one Yjs update of the room's generation into the document's log. Body `{room, generation,
 * update_id (uuid), sha256 (hex of the payload), payload (base64), origin: client|server, seed_state_version?}`. The
 * answer `{generation, update_id, seq, sha256, persisted: true, permissions_stale}` is built after the commit; a retry
 * with the same update_id and payload gets the same seq. `permissions_stale` is true when the token predates a change
 * of its drive's rights: the append was allowed by the rights now, and the hub renews the token. The base64 length is checked against `limits.update_bytes` before it is
 * decoded — against `max_state_bytes` for a seed, which carries the document's whole initial state. `seed_state_version`
 * marks the hub's seed (409 collaboration_seed_conflict unless the generation has no checkpoint and no record yet and the
 * document's state version still equals it). The size gate ({@see LimitHubAppend}) takes a body of a whole state for a
 * request that declares a seed; a body that is no seed is held to `limits.request_bytes` here.
 */
#[Internal]
final readonly class HubAppendController
{
    public function __construct(private CollaborationHub $hub, private CollaborationOptions $config) {}

    public function __invoke(Request $request): JsonResponse
    {
        HubProtocol::require($request);
        $call = ResolveCollaborationCall::call($request);
        $update = $this->envelope($request);
        $room = $this->hub->open($call, $request->input('room'));

        // The rights were checked above whatever the token's permission versions; a stale token tells the hub to renew.
        return HubProtocol::mark(new JsonResponse([...$this->hub->append($room, $call, $update)->ack(), 'permissions_stale' => $room->permissionsStale]));
    }

    private function envelope(Request $request): UpdateEnvelope
    {
        $generation = $request->input('generation');
        $updateId = $request->input('update_id');
        $sha256 = $request->input('sha256');
        $payload = $request->input('payload');
        $origin = $request->input('origin', 'client');
        $seedStateVersion = $request->input('seed_state_version');

        $errors = array_filter([
            'generation' => is_int($generation) && $generation >= 0 ? null : 'The generation must be a non-negative integer.',
            'update_id' => is_string($updateId) && Str::isUuid($updateId) ? null : 'The update_id must be a UUID.',
            'sha256' => is_string($sha256) && preg_match('/^[0-9a-fA-F]{64}$/', $sha256) === 1 ? null : 'The sha256 must be 64 hex digits.',
            'payload' => is_string($payload) && $payload !== '' ? null : 'The payload must be a non-empty base64 string.',
            'origin' => in_array($origin, ['client', 'server'], true) ? null : 'The origin must be client or server.',
            'seed_state_version' => $seedStateVersion === null || (is_int($seedStateVersion) && $seedStateVersion >= 0)
                ? null
                : 'The seed_state_version must be a non-negative integer.',
        ]);
        if ($errors !== [] || !is_int($generation) || !is_string($updateId) || !is_string($sha256) || !is_string($payload) || !is_string($origin)
            || ($seedStateVersion !== null && !is_int($seedStateVersion))) {
            throw ValidationException::withMessages(array_map(static fn (string $message): array => [$message], $errors));
        }

        // The gate let a body of a whole state through for a request that declared a seed: anything else is one update.
        $body = strlen($request->getContent());
        if ($seedStateVersion === null && $body > $this->config->requestBytes()) {
            throw new CollaborationUpdateTooLargeException($body, $this->config->requestBytes());
        }

        // The size is known from the encoded length: refuse before decoding allocates the update. A seed is the whole
        // initial state of the document, bounded as a state is; every other record is one update.
        $max = $seedStateVersion === null ? $this->config->updateBytes() : $this->config->maxStateBytes();
        $encodedMax = 4 * (int) ceil($max / 3);
        if (strlen($payload) > $encodedMax) {
            throw new CollaborationUpdateTooLargeException(intdiv(strlen($payload), 4) * 3, $max);
        }
        $decoded = base64_decode($payload, strict: true);
        if ($decoded === false || $decoded === '') {
            throw ValidationException::withMessages(['payload' => ['The payload must be valid base64-encoded binary.']]);
        }
        if (strlen($decoded) > $max) {
            throw new CollaborationUpdateTooLargeException(strlen($decoded), $max);
        }

        return new UpdateEnvelope(
            generation: $generation,
            updateId: strtolower($updateId),
            payload: $decoded,
            claimedSha256: $sha256,
            origin: $origin,
            seedStateVersion: $seedStateVersion,
        );
    }
}
