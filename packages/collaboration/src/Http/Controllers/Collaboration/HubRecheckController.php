<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Controllers\Collaboration;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Revocation\SessionChecks;

/**
 * Protocol 2 batch recheck: after a control message the hub asks what each connection of the drive (of every
 * drive for a global change) may do now. Body `{connections: [{id, token}]}` (1..200; `id` is the hub's own key of the
 * connection, 1..191 bytes; `token` its current room token). The answer `{results: [{id, access: none|read|write,
 * reason, jti}]}` keeps the order: `none` closes the connection (reason token|gone|generation|unavailable|revoked),
 * `read` makes it read-only, `write` leaves it. The call is the hub's own: the body signature authenticates it, and
 * every token is verified on its own.
 */
#[Internal]
final readonly class HubRecheckController
{
    public function __construct(private SessionChecks $checks) {}

    public function __invoke(Request $request): JsonResponse
    {
        HubProtocol::require($request);

        return HubProtocol::mark(new JsonResponse(['results' => $this->checks->recheck($this->connections($request))]));
    }

    /** @return list<array{id: string, token: string}> */
    private function connections(Request $request): array
    {
        $connections = $request->input('connections');
        if (!is_array($connections) || !array_is_list($connections) || $connections === [] || count($connections) > SessionChecks::MAX_RECHECK) {
            throw ValidationException::withMessages(['connections' => ['The connections must be a list of 1 to '.SessionChecks::MAX_RECHECK.' entries.']]);
        }

        $valid = [];
        foreach ($connections as $index => $connection) {
            $id = is_array($connection) ? ($connection['id'] ?? null) : null;
            $token = is_array($connection) ? ($connection['token'] ?? null) : null;
            if (!is_string($id) || $id === '' || strlen($id) > 191 || !is_string($token) || $token === '') {
                throw ValidationException::withMessages(["connections.$index" => ['Each connection needs an id of 1 to 191 bytes and a token.']]);
            }
            $valid[] = ['id' => $id, 'token' => $token];
        }

        return $valid;
    }
}
