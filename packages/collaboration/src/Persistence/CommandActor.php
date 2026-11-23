<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use InvalidArgumentException;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use Vaulter\ValueObjects\Access\ActorRef;

/** Authority supplied by the application after it resolves the real caller and project. */
#[Spi(SpiKind::Call)]
final readonly class CommandActor
{
    public function __construct(
        public ActorRef $principal,
        public ?string $tenant,
        public string $project,
        public string $subject,
        public string $driveId,
        public string $resourceId,
    ) {
        foreach ([$project, $subject] as $value) {
            if ($value === '' || strlen($value) > 255) {
                throw new InvalidArgumentException('Invalid collaboration command scope.');
            }
        }
        if ($principal->id === null || $principal->type === null || ($tenant !== null && (string) (int) $tenant !== $tenant)) {
            throw new InvalidArgumentException('Invalid collaboration command principal or tenant.');
        }
    }
}
