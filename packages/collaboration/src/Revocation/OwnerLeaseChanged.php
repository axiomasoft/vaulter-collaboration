<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation;

use Packman\Attributes\Internal;

/** A committed ownership acquisition superseded this room's previous fence. */
#[Internal]
final readonly class OwnerLeaseChanged
{
    public function __construct(
        public string $room,
        public int $previousFence,
    ) {}
}
