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

    public function __construct(public readonly string $reason, private readonly ?LogSnapshot $replay = null)
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
        $context = ['reason' => $this->reason];
        if ($this->replay !== null) {
            $context['replay'] = [
                'generation' => $this->replay->generation,
                'state_format' => $this->replay->binding->stateFormat,
                'checkpoint' => $this->replay->checkpoint === null ? null : base64_encode($this->replay->checkpoint),
                'checkpoint_seq' => $this->replay->checkpointSeq,
                'head_seq' => $this->replay->headSeq,
                'tail' => $this->replay->tail,
            ];
        }

        return ['context' => $context];
    }

    public function errorDescriptor(): ErrorDescriptor
    {
        return new ErrorDescriptor(code: CollaborationErrorCode::RoomConflict, category: ErrorCategory::Conflict, retryable: true);
    }
}
