<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Controllers\Collaboration;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\CollaborationHub;
use Vaulter\Collaboration\Http\Middleware\ResolveCollaborationCall;
use Vaulter\Collaboration\Http\Support\HubProtocol;

/**
 * The hub's onAuthenticate (protocol 2): is the connection allowed, and in which mode, right now.
 * `allowed: false` (rather than a 403) when the user no longer holds View, so the hub
 * refuses the socket cleanly. A room of a past generation answers 409
 * collaboration_epoch_mismatch and the client asks for a new session.
 */
#[Internal]
final readonly class HubAuthenticateController
{
    public function __construct(private CollaborationHub $hub) {}

    public function __invoke(Request $request): JsonResponse
    {
        HubProtocol::require($request);
        $room = $this->hub->authenticate(ResolveCollaborationCall::call($request), $request->input('room'));

        if ($room === null) {
            return HubProtocol::mark(new JsonResponse(['allowed' => false, 'mode' => 'ro', 'userId' => null]));
        }

        return HubProtocol::mark(new JsonResponse([
            'allowed' => true,
            'mode' => $room->mode(),
            'userId' => $room->userId,
            'epoch' => $room->grant->generation,
        ]));
    }
}
