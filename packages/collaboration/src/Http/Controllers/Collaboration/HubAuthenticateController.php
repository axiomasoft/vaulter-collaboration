<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Controllers\Collaboration;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
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
        $call = ResolveCollaborationCall::call($request);
        $room = $this->hub->authenticate($call, $request->input('room'));

        if ($room === null) {
            return HubProtocol::mark(new JsonResponse(['allowed' => false, 'mode' => 'ro', 'userId' => null]));
        }

        $profile = $this->hub->profile($room, $call, $request->input('strict_capable') === true);
        $binding = [];
        $session = $request->input('bind_session');
        if ($profile === 'strict' && $session !== null) {
            if (!is_string($session) || !Str::isUuid($session)) {
                throw ValidationException::withMessages(['bind_session' => ['The browser session must be a UUID.']]);
            }
            $binding['bound_client_id'] = $this->hub->bindBrowser($call, strtolower($session));
        }

        return HubProtocol::mark(new JsonResponse([
            'allowed' => true,
            'mode' => $room->mode(),
            'userId' => $room->userId,
            'epoch' => $room->grant->generation,
        ] + ($profile === 'strict' ? ['profile' => $profile] : []) + $binding));
    }
}
