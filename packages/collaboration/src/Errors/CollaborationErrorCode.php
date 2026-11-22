<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Errors;

use Override;
use Packman\Attributes\Api;
use Packman\Errors\Contracts\ErrorCode;

/**
 * Canonical Packman error codes owned by `axiomasoft/vaulter-collaboration`.
 */
#[Api(since: '1.0')]
enum CollaborationErrorCode: string implements ErrorCode
{
    case SeedConflict = 'collaboration.seed_conflict';
    case Config = 'collaboration.config';
    case UpdateMismatch = 'collaboration.update_mismatch';
    case CheckpointConflict = 'collaboration.checkpoint_conflict';
    case UpdateTooLarge = 'collaboration.update_too_large';
    case EpochMismatch = 'collaboration.epoch_mismatch';
    case ProtocolMismatch = 'collaboration.protocol_mismatch';
    case Draining = 'collaboration.draining';

    #[Override]
    public function value(): string
    {
        return $this->value;
    }
}
