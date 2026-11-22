<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Support;

use RuntimeException;
use Vaulter\Collaboration\Revocation\ControlTransport;

/** A control transport that keeps the messages it was handed (decoded), or fails every publication when told to. */
final class RecordingControlTransport implements ControlTransport
{
    /** @var list<array<string, mixed>> */
    public array $messages = [];

    public function __construct(public bool $fail = false) {}

    public function name(): string
    {
        return 'recording';
    }

    public function publish(string $message): void
    {
        if ($this->fail) {
            throw new RuntimeException('the hubs are unreachable');
        }

        /** @var array<string, mixed> $decoded */
        $decoded = json_decode($message, true, flags: JSON_THROW_ON_ERROR);
        $this->messages[] = $decoded;
    }
}
