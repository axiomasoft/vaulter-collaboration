<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation\Transports;

use Packman\Attributes\Internal;
use RuntimeException;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Revocation\ControlTransport;
use Vaulter\Database\VaulterDatabase;

/** Publishes signed control notifications on the primary Vaulter PostgreSQL database. */
#[Internal]
final readonly class PostgresListenNotifyTransport implements ControlTransport
{
    public const string CHANNEL = 'vaulter_collab_control';

    public function __construct(
        private VaulterDatabase $database,
        private CollaborationOptions $config,
    ) {}

    public function name(): string
    {
        return 'postgres';
    }

    public function publish(string $message): void
    {
        $secret = $this->config->hubWebhookSecret();
        if ($secret === null || $this->database->driver() !== 'pgsql') {
            throw new RuntimeException('PostgreSQL control delivery requires PostgreSQL and a hub webhook secret.');
        }
        $timestamp = time();
        $notification = json_encode([
            'timestamp' => (string) $timestamp,
            'signature' => CollaborationCallResolver::signature(rawBody: $message, secret: $secret->reveal(), timestamp: $timestamp),
            'body' => $message,
        ], JSON_THROW_ON_ERROR);
        $this->database->connection()->statement('SELECT pg_notify(?, ?)', [self::CHANNEL, $notification]);
    }
}
