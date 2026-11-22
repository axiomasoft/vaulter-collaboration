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
 * The hub's onLoadDocument (protocol 2, header `X-Vaulter-Collab-Protocol: 2`): the checkpoint, the log sequence it
 * covers and the committed tail to replay on top of it; before the generation has any record, the JSON to seed it from.
 */
#[Internal]
final readonly class HubLoadController
{
    public function __construct(private CollaborationHub $hub) {}

    public function __invoke(Request $request): JsonResponse
    {
        HubProtocol::require($request);
        $call = ResolveCollaborationCall::call($request);
        $room = $this->hub->open($call, $request->input('room'));

        return HubProtocol::mark(new JsonResponse($this->hub->loadLog($room, $call)));
    }
}
