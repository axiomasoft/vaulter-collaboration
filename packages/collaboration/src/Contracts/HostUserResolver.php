<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Contracts;

use Illuminate\Contracts\Auth\Access\Authorizable;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use Vaulter\ValueObjects\Access\ActorRef;

/** Resolves a typed host principal; return null for an unknown or mismatching type/id. */
#[Spi(SpiKind::Implement)]
interface HostUserResolver
{
    public function find(ActorRef $principal): ?Authorizable;
}
