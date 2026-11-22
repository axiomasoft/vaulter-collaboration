<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Exceptions;

use Override;
use Packman\Attributes\Api;
use Packman\Attributes\Internal;
use Packman\Errors\Data\ErrorDescriptor;
use Packman\Errors\Enums\ErrorCategory;
use Vaulter\Collaboration\Errors\CollaborationErrorCode;
use Vaulter\Exceptions\Concerns\ProvidesProblemDetails;
use Vaulter\Exceptions\Contracts\ProblemException;
use Vaulter\Exceptions\VaulterException;

/**
 * The collaboration module is draining: `vaulter:collaboration:drain` set the draining flag, so the log takes no
 * new update while the hub checkpoints the pending documents before the module is switched off. Nothing was written;
 * the hub keeps the update in its retry queue, and it is accepted again once `--release` removed the flag.
 */
#[Api]
final class CollaborationDrainingException extends VaulterException implements ProblemException
{
    use ProvidesProblemDetails;

    #[Internal]
    public function __construct()
    {
        parent::__construct(sprintf(
            '[Vaulter] The collaboration log takes no updates while it is drained (vaulter:collaboration:drain); retry later. Docs: %s',
            self::docs('collaboration-draining'),
        ));
    }

    public function problemCode(): string
    {
        return 'collaboration_draining';
    }

    public function httpStatus(): int
    {
        return 503;
    }

    #[Override]
    public function errorDescriptor(): ErrorDescriptor
    {
        return new ErrorDescriptor(code: CollaborationErrorCode::Draining, category: ErrorCategory::Unavailable, retryable: true);
    }
}
