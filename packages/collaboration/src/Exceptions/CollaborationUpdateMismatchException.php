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
 * An appended update does not match itself or its id: the sha256 the hub sent is not the hash of the payload, or the
 * update_id already has a receipt of this generation with another payload. Nothing is written; repeating the same
 * request gives the same answer, so the update is dropped, not retried.
 */
#[Api]
final class CollaborationUpdateMismatchException extends VaulterException implements ProblemException
{
    use ProvidesProblemDetails;

    #[Internal]
    public function __construct(public readonly string $updateId, public readonly string $reason)
    {
        parent::__construct(sprintf(
            '[Vaulter] The collaboration update %s was refused: %s. Docs: %s',
            $updateId,
            $reason === 'hash' ? 'its sha256 is not the hash of its payload' : 'its id was committed with another payload',
            self::docs('collaboration-update-mismatch'),
        ));
    }

    public static function hash(string $updateId): self
    {
        return new self($updateId, 'hash');
    }

    public static function receipt(string $updateId): self
    {
        return new self($updateId, 'receipt');
    }

    public function problemCode(): string
    {
        return 'collaboration_update_mismatch';
    }

    public function httpStatus(): int
    {
        return 422;
    }

    /** @return array<string, mixed> */
    public function problemDetails(): array
    {
        return ['context' => ['update_id' => $this->updateId, 'reason' => $this->reason]];
    }

    #[Override]
    public function errorDescriptor(): ErrorDescriptor
    {
        return new ErrorDescriptor(code: CollaborationErrorCode::UpdateMismatch, category: ErrorCategory::Validation);
    }
}
