<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Drain;

use Closure;
use Illuminate\Support\Carbon;
use Illuminate\Support\Sleep;
use Packman\Attributes\Internal;
use Vaulter\Documents\State\PendingMarker;

/**
 * Polls a drain with exponential backoff (50 ms doubling to 1 s), never sleeping past the deadline, and checks once more
 * at the deadline. The clock is Carbon's and the sleep Laravel's, so a test moves both together (Sleep::fake with
 * syncWithCarbon).
 */
#[Internal]
final readonly class BackoffDrainWaiter implements DrainWaiter
{
    private const int FIRST_DELAY_MS = 50;

    private const int MAX_DELAY_MS = 1000;

    public function wait(PendingMarker $marker, Closure $settled, int $deadlineSeconds): bool
    {
        $deadline = Carbon::now()->getTimestampMs() + $deadlineSeconds * 1000;
        $delay = self::FIRST_DELAY_MS;
        while (!$settled()) {
            $remaining = $deadline - Carbon::now()->getTimestampMs();
            if ($remaining <= 0) {
                return false;
            }
            Sleep::for(min($delay, $remaining))->milliseconds();
            $delay = min($delay * 2, self::MAX_DELAY_MS);
        }

        return true;
    }
}
