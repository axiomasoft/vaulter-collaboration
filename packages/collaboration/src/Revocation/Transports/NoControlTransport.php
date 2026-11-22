<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation\Transports;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\Revocation\ControlTransport;

/** `control.transport = none`: nothing is sent; the hubs learn of a change on the next append or renewal. */
#[Internal]
final readonly class NoControlTransport implements ControlTransport
{
    public function name(): string
    {
        return 'none';
    }

    public function publish(string $message): void {}
}
