<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Support;

use Packman\Attributes\Internal;
use Vaulter\Contracts\Routing\RouteLabelSource;

/** The metric labels of the collaboration routes: the session and the hub calls (the RouteLabelSource contribution of the collaboration module). */
#[Internal]
final class CollaborationRouteLabels implements RouteLabelSource
{
    public function operations(): array
    {
        return [
            'vaulter.v1.collaboration.hub.append' => 'collab_append',
            'vaulter.v1.collaboration.hub.compaction.lease' => 'collab_lease',
            'vaulter.v1.collaboration.hub.checkpoint' => 'collab_checkpoint',
            'vaulter.v1.collaboration.hub.renew' => 'collab_renew',
            'vaulter.v1.collaboration.hub.recheck' => 'collab_recheck',
        ];
    }

    public function operationPaths(): array
    {
        return [
            ['methods' => ['POST'], 'pattern' => 'v1/collaboration/hub/append', 'operation' => 'collab_append'],
            ['methods' => ['POST'], 'pattern' => 'v1/collaboration/hub/compaction/lease', 'operation' => 'collab_lease'],
            ['methods' => ['POST'], 'pattern' => 'v1/collaboration/hub/checkpoint', 'operation' => 'collab_checkpoint'],
            ['methods' => ['POST'], 'pattern' => 'v1/collaboration/hub/renew', 'operation' => 'collab_renew'],
            ['methods' => ['POST'], 'pattern' => 'v1/collaboration/hub/recheck', 'operation' => 'collab_recheck'],
        ];
    }

    public function throttled(): array
    {
        return [
            'vaulter.v1.collaboration.hub.authenticate' => 'collab.authenticate',
            'vaulter.v1.collaboration.hub.append' => 'collab.append',
            'vaulter.v1.collaboration.hub.compaction.lease' => 'collab.lease',
            'vaulter.v1.collaboration.hub.checkpoint' => 'collab.checkpoint',
            'vaulter.v1.collaboration.hub.renew' => 'collab.renew',
            'vaulter.v1.collaboration.hub.recheck' => 'collab.recheck',
        ];
    }
}
