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
 * A checkpoint publication lost its compare-and-set: its compaction lease is not the current one (another hub's,
 * expired, or already spent), or the log moved since the lease read it (another checkpoint covers it, the document's
 * state version changed, or the covered range is not in the log). Nothing was published and no update was deleted;
 * the hub drops its merge and takes a new lease. `$reason` names the check that failed.
 */
#[Api]
final class CollaborationCheckpointConflictException extends VaulterException implements ProblemException
{
    use ProvidesProblemDetails;

    public const string LEASE = 'lease';

    public const string COVERAGE = 'coverage';

    public const string VERSION = 'checkpoint_version';

    #[Internal]
    public function __construct(public readonly string $reason)
    {
        parent::__construct(sprintf(
            '[Vaulter] The collaboration checkpoint lost its compare-and-set (%s); take a new compaction lease. Docs: %s',
            $reason,
            self::docs('collaboration-checkpoint-conflict'),
        ));
    }

    public function problemCode(): string
    {
        return 'collaboration_checkpoint_conflict';
    }

    public function httpStatus(): int
    {
        return 409;
    }

    /** @return array<string, mixed> */
    public function problemDetails(): array
    {
        return ['context' => ['reason' => $this->reason]];
    }

    #[Override]
    public function errorDescriptor(): ErrorDescriptor
    {
        return new ErrorDescriptor(code: CollaborationErrorCode::CheckpointConflict, category: ErrorCategory::Conflict, retryable: true);
    }
}
