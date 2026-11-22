<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation;

use Packman\Attributes\Internal;
use Throwable;

/**
 * How {@see ControlConsumer} hands a control message to the hubs (`vaulter-collaboration.control.transport`): Redis
 * pub/sub, an HTTP POST to every hub's management port, or nothing. A message is sent once; a failure is the
 * consumer's to report, never retried.
 */
#[Internal]
interface ControlTransport
{
    /** The transport's name, as in the configuration (the label of its metrics). */
    public function name(): string;

    /**
     * @param string $message the JSON of one control message
     *
     * @throws Throwable when the message did not reach every hub
     */
    public function publish(string $message): void;
}
