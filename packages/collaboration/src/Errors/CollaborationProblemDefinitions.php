<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Errors;

use Override;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use Packman\Errors\Contracts\ProblemDefinitionProvider;
use Packman\Errors\Data\ProblemDefinition;
use Packman\Errors\Enums\ErrorCategory;

/**
 * Registers RFC 9457 problem definitions for all `axiomasoft/vaulter-collaboration` error codes.
 */
#[Spi(kind: SpiKind::Call, since: '1.0')]
final class CollaborationProblemDefinitions implements ProblemDefinitionProvider
{
    private const string URN_PREFIX = 'urn:packman:problem:';

    /** @return iterable<ProblemDefinition> */
    #[Override]
    public function definitions(): iterable
    {
        yield new ProblemDefinition(code: CollaborationErrorCode::SeedConflict, type: self::URN_PREFIX.CollaborationErrorCode::SeedConflict->value, defaultStatus: 409, title: 'Seed conflict', retryable: true, category: ErrorCategory::Conflict);
        yield new ProblemDefinition(code: CollaborationErrorCode::Config, type: self::URN_PREFIX.CollaborationErrorCode::Config->value, defaultStatus: 500, title: 'Config', retryable: false, category: ErrorCategory::Internal);
        yield new ProblemDefinition(code: CollaborationErrorCode::UpdateMismatch, type: self::URN_PREFIX.CollaborationErrorCode::UpdateMismatch->value, defaultStatus: 422, title: 'Update mismatch', retryable: false, category: ErrorCategory::Validation);
        yield new ProblemDefinition(code: CollaborationErrorCode::CheckpointConflict, type: self::URN_PREFIX.CollaborationErrorCode::CheckpointConflict->value, defaultStatus: 409, title: 'Checkpoint conflict', retryable: true, category: ErrorCategory::Conflict);
        yield new ProblemDefinition(code: CollaborationErrorCode::UpdateTooLarge, type: self::URN_PREFIX.CollaborationErrorCode::UpdateTooLarge->value, defaultStatus: 413, title: 'Update too large', retryable: false, category: ErrorCategory::Validation);
        yield new ProblemDefinition(code: CollaborationErrorCode::EpochMismatch, type: self::URN_PREFIX.CollaborationErrorCode::EpochMismatch->value, defaultStatus: 409, title: 'Epoch mismatch', retryable: true, category: ErrorCategory::Conflict);
        yield new ProblemDefinition(code: CollaborationErrorCode::ProtocolMismatch, type: self::URN_PREFIX.CollaborationErrorCode::ProtocolMismatch->value, defaultStatus: 409, title: 'Protocol mismatch', retryable: false, category: ErrorCategory::Conflict);
        yield new ProblemDefinition(code: CollaborationErrorCode::Draining, type: self::URN_PREFIX.CollaborationErrorCode::Draining->value, defaultStatus: 503, title: 'Draining', retryable: true, category: ErrorCategory::Unavailable);
    }
}
