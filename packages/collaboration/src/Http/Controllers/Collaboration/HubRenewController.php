<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Controllers\Collaboration;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Http\Middleware\ResolveCollaborationCall;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Revocation\SessionChecks;

/**
 * Protocol 2 renewal: the hub asks, before a connection's token expires, for a new one. Body `{room}` with the
 * current token as the bearer. The rights are checked now: the answer `{token, room, generation, scope (read|write),
 * mode (ro|rw), exp, jti, permissions_version: {drive, global}}` carries a new exp of `hub.token_ttl` from now and a
 * scope no wider than the old token's or the subject's rights now (a writer who lost Edit is renewed read-only); a
 * subject without View gets 403 permission_denied, a gone document 404, a past generation 409
 * collaboration_epoch_mismatch. The old token is not extended.
 */
#[Internal]
final readonly class HubRenewController
{
    public function __construct(private SessionChecks $checks) {}

    public function __invoke(Request $request): JsonResponse
    {
        HubProtocol::require($request);

        return HubProtocol::mark(new JsonResponse($this->checks->renew(ResolveCollaborationCall::call($request), $request->input('room'))));
    }
}
