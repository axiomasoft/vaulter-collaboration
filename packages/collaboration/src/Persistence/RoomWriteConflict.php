<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Api;
use Packman\Errors\Data\ErrorDescriptor;
use Packman\Errors\Enums\ErrorCategory;
use Vaulter\Collaboration\Errors\CollaborationErrorCode;
use Vaulter\Exceptions\Concerns\ProvidesProblemDetails;
use Vaulter\Exceptions\Contracts\ProblemException;
use Vaulter\Exceptions\VaulterException;

#[Api]
final class RoomWriteConflict extends VaulterException implements ProblemException
{
    use ProvidesProblemDetails;

    public function __construct(public readonly string $reason)
    {
        parent::__construct('The collaboration room refused the operation ('.$reason.').');
    }

    public function problemCode(): string
    {
        return 'collaboration_room_conflict';
    }

    public function httpStatus(): int
    {
        return 409;
    }

    public function problemDetails(): array
    {
        return ['context' => ['reason' => $this->reason]];
    }

    public function errorDescriptor(): ErrorDescriptor
    {
        return new ErrorDescriptor(code: CollaborationErrorCode::RoomConflict, category: ErrorCategory::Conflict, retryable: true);
    }
}
