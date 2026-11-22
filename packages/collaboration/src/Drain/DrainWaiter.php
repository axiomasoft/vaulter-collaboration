<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Drain;

use Closure;
use Packman\Attributes\Internal;
use Vaulter\Documents\State\PendingMarker;

/**
 * How {@see HubDrainer} waits for the hub to compact a drained generation: outside any transaction, polling
 * `$settled` until it answers true or the deadline passed. The default polls with backoff ({@see BackoffDrainWaiter});
 * a test binds a fake hub that does the compaction on its first poll.
 */
#[Internal]
interface DrainWaiter
{
    /**
     * @param  Closure(): bool $settled whether the marker of the drained generation is gone
     * @return bool            whether it settled before the deadline
     */
    public function wait(PendingMarker $marker, Closure $settled, int $deadlineSeconds): bool;
}
