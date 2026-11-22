<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Internal;

/**
 * A published checkpoint: the state version it holds (the next lease's checkpoint version) and whether it cleared the
 * pending marker. A marker of edits committed after the hub read the log stays set, and their updates stay in the log.
 */
#[Internal]
final readonly class CheckpointResult
{
    public function __construct(
        public int $checkpointVersion,
        public bool $markerCleared,
    ) {}

    /** @return array{checkpoint_version: int, marker_cleared: bool} */
    public function toArray(): array
    {
        return ['checkpoint_version' => $this->checkpointVersion, 'marker_cleared' => $this->markerCleared];
    }
}
