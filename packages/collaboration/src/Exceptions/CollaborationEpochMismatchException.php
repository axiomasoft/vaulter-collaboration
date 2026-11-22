<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Exceptions;

use Override;
use Packman\Attributes\Api;
use Packman\Errors\Data\ErrorDescriptor;
use Packman\Errors\Enums\ErrorCategory;
use Vaulter\Collaboration\Errors\CollaborationErrorCode;
use Vaulter\Exceptions\Concerns\ProvidesProblemDetails;
use Vaulter\Exceptions\Contracts\ProblemException;
use Vaulter\Exceptions\VaulterException;

/**
 * A collaboration write came from a room generation the document has left (a
 * restore or an external replace moved collab_epoch on). Accepting it would merge
 * an abandoned Yjs history back into the document, so the write is fenced off; the
 * hub treats the 409 as terminal and closes the room.
 */
#[Api]
final class CollaborationEpochMismatchException extends VaulterException implements ProblemException
{
    use ProvidesProblemDetails;

    public function __construct(
        public readonly int $expected,
        public readonly int $actual,
    ) {
        parent::__construct(sprintf(
            '[Vaulter] The collaboration room is from epoch %d, the document is at epoch %d; reopen the document. Docs: %s',
            $expected,
            $actual,
            self::docs('collaboration-epoch-mismatch'),
        ));
    }

    public function problemCode(): string
    {
        return 'collaboration_epoch_mismatch';
    }

    public function httpStatus(): int
    {
        return 409;
    }

    /**
     * @return array<string, mixed>
     */
    public function problemDetails(): array
    {
        return ['context' => ['expected' => $this->expected, 'actual' => $this->actual]];
    }

    #[Override]
    public function errorDescriptor(): ErrorDescriptor
    {
        return new ErrorDescriptor(code: CollaborationErrorCode::EpochMismatch, category: ErrorCategory::Conflict, retryable: true);
    }
}
