<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Drain;

use Illuminate\Contracts\Cache\Factory as CacheFactory;
use Illuminate\Contracts\Cache\Repository as Cache;
use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Exceptions\CollaborationDrainingException;

/**
 * The draining flag of a managed disable. `vaulter:collaboration:drain` sets it, and from then on every append is
 * refused with 503 collaboration_draining before it takes a lock, while the hub checkpoints what the log holds; it stays
 * until `vaulter:collaboration:drain --release` removes it, also across a switch-off and on again of the module.
 *
 * The flag is the key `vaulter:collaboration:draining` of the cache store `vaulter-collaboration.drain.cache_store` (the
 * default store when null), without expiry; its value is the moment it was set (Unix milliseconds). Every PHP process
 * must share that store: in an `array` or `null` store the flag would stop the appends of one process only (the doctor
 * check collaboration.hub reports it). A store that cannot be read refuses the append with its own error.
 *
 * An append reads the flag twice: before any lock, and as the last statement of its transaction, so an append that
 * missed the flag has nothing but its commit left once the flag is set.
 */
#[Internal]
final readonly class DrainState
{
    public const string KEY = 'vaulter:collaboration:draining';

    public function __construct(private CacheFactory $cache, private CollaborationOptions $config) {}

    /**
     * Set the flag; a flag set already keeps the moment it was first set. Returns that moment as the store reads it back,
     * or null when the store did not keep the flag (a failed write, a store that drops it): appends are still accepted
     * then, and a drain must not go on.
     */
    public function begin(): ?Carbon
    {
        $since = $this->since();
        if ($since !== null) {
            return $since;
        }
        if (!$this->store()->forever(self::KEY, Carbon::now()->getTimestampMs())) {
            return null;
        }

        return $this->since();
    }

    /** When the flag was set; null while appends are accepted. */
    public function since(): ?Carbon
    {
        $value = $this->store()->get(self::KEY);

        return is_int($value) || (is_string($value) && ctype_digit($value)) ? Carbon::createFromTimestampMs((int) $value) : null;
    }

    /** Remove the flag; false when it was not set. */
    public function release(): bool
    {
        $set = $this->since() !== null;
        $this->store()->forget(self::KEY);

        return $set;
    }

    /** @throws CollaborationDrainingException while the flag is set */
    public function assertAccepting(): void
    {
        if ($this->store()->has(self::KEY)) {
            throw new CollaborationDrainingException;
        }
    }

    private function store(): Cache
    {
        return $this->cache->store($this->config->drainCacheStore());
    }
}
