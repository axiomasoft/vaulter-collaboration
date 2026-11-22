<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation;

use Packman\Attributes\Internal;
use Vaulter\Drive\Events\Access\EffectivePermissionsChanged;
use Vaulter\Events\DomainEvent;
use Vaulter\Events\EventSink;
use Vaulter\Events\SinkResult;
use Vaulter\Events\SinkWriter;

/**
 * Counts a change of effective permissions (`collaboration.permissions`, an event sink): in the transaction of
 * drive.access.effective_permissions_changed it increments the version of the event's drive (`drive:<id>`, for a node,
 * subtree or drive scope) or the global version. The change and its count commit or roll back together.
 *
 * It keeps nothing of the event itself and answers Skipped, so it cannot tell a replayed occurrence from a new one: a
 * replay counts once more, which only makes a session re-check its rights once more.
 */
#[Internal]
final readonly class PermissionVersionSink implements EventSink
{
    public const string ID = 'collaboration.permissions';

    public function __construct(private PermissionVersions $versions) {}

    public function record(DomainEvent $event, SinkWriter $writer): SinkResult
    {
        if ($event instanceof EffectivePermissionsChanged) {
            $this->versions->increment($writer, PermissionVersions::key($event->driveId));
        }

        return SinkResult::Skipped;
    }
}
