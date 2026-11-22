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
 * An append request or its update is above the configured limit (`vaulter-collaboration.limits.request_bytes` for the
 * body, `limits.update_bytes` for the decoded update). The size is checked before the body is decoded; nothing is
 * written, and the same update never fits later. A body without a declared Content-Length is refused unread: its size
 * is null.
 */
#[Api]
final class CollaborationUpdateTooLargeException extends VaulterException implements ProblemException
{
    use ProvidesProblemDetails;

    #[Internal]
    public function __construct(public readonly ?int $sizeBytes, public readonly int $maxBytes)
    {
        parent::__construct(sprintf(
            '[Vaulter] The collaboration update is %s, above the limit of %d bytes. Docs: %s',
            $sizeBytes === null ? 'of an undeclared size' : $sizeBytes.' bytes',
            $maxBytes,
            self::docs('collaboration-update-too-large'),
        ));
    }

    /** A request body without a usable Content-Length: it is not read to be measured. */
    #[Internal]
    public static function undeclared(int $maxBytes): self
    {
        return new self(null, $maxBytes);
    }

    public function problemCode(): string
    {
        return 'collaboration_update_too_large';
    }

    public function httpStatus(): int
    {
        return 413;
    }

    /** @return array<string, mixed> */
    public function problemDetails(): array
    {
        return ['context' => ['size_bytes' => $this->sizeBytes, 'max_bytes' => $this->maxBytes]];
    }

    #[Override]
    public function errorDescriptor(): ErrorDescriptor
    {
        return new ErrorDescriptor(code: CollaborationErrorCode::UpdateTooLarge, category: ErrorCategory::Validation);
    }
}
