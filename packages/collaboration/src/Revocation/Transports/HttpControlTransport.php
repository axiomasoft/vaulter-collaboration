<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation\Transports;

use Illuminate\Http\Client\Factory;
use Packman\Attributes\Internal;
use RuntimeException;
use Throwable;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Revocation\ControlTransport;

/**
 * `control.transport = http`: POST `<url>/control` to every hub of `control.http.urls`, signed as the hub signs its own
 * calls — HMAC-SHA256 of "{timestamp}.{rawBody}" keyed by hub.webhook_secret in X-Vaulter-Collab-Timestamp and
 * X-Vaulter-Collab-Signature. Every hub is tried; a non-2xx answer or an unreachable hub fails the publication after
 * the others were tried.
 */
#[Internal]
final readonly class HttpControlTransport implements ControlTransport
{
    public const string PATH = '/control';

    public function __construct(
        private Factory $http,
        private CollaborationOptions $config,
    ) {}

    public function name(): string
    {
        return 'http';
    }

    public function publish(string $message): void
    {
        $secret = $this->config->hubWebhookSecret();
        if ($secret === null) {
            throw new RuntimeException('the hub webhook secret that signs control messages is not set');
        }
        $urls = $this->config->controlHttpUrls();
        if ($urls === []) {
            throw new RuntimeException('vaulter-collaboration.control.http.urls names no hub');
        }

        $failed = [];
        foreach ($urls as $url) {
            $timestamp = time();
            try {
                $this->http->timeout($this->config->controlHttpTimeout())
                    ->withHeaders([
                        CollaborationCallResolver::TIMESTAMP_HEADER => (string) $timestamp,
                        CollaborationCallResolver::SIGNATURE_HEADER => CollaborationCallResolver::signature(rawBody: $message, secret: $secret->reveal(), timestamp: $timestamp),
                    ])
                    ->withBody($message, 'application/json')
                    ->post($url.self::PATH)
                    ->throw();
            } catch (Throwable $failure) {
                $failed[] = $url.': '.$failure->getMessage();
            }
        }
        if ($failed !== []) {
            throw new RuntimeException(sprintf('the control message reached %d of %d hubs (%s)', count($urls) - count($failed), count($urls), implode('; ', $failed)));
        }
    }
}
