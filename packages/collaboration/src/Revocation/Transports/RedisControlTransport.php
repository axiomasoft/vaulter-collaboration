<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation\Transports;

use Illuminate\Contracts\Redis\Factory;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Revocation\ControlTransport;

/** `control.transport = redis`: PUBLISH on `vaulter:collab:control` of `control.redis.connection`; every hub subscribes. */
#[Internal]
final readonly class RedisControlTransport implements ControlTransport
{
    public const string CHANNEL = 'vaulter:collab:control';

    public function __construct(
        private Factory $redis,
        private CollaborationOptions $config,
    ) {}

    public function name(): string
    {
        return 'redis';
    }

    public function publish(string $message): void
    {
        $this->redis->connection($this->config->controlRedisConnection())->command('publish', [self::CHANNEL, $message]);
    }
}
