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
 * A hub tried to append the seed of a generation that already has a record or a checkpoint —
 * or whose JSON moved on since the hub read it (a REST update between collab/load and the
 * seed append: it does not move the epoch while there is no Yjs state, so the state version
 * is the precondition). Seeding builds new Yjs insertions from the JSON; a second seed would
 * duplicate the whole document when the rooms merge, and a stale one would overwrite the
 * newer text, so the seed is refused and the hub reloads the document.
 */
#[Api]
final class CollaborationSeedConflictException extends VaulterException implements ProblemException
{
    use ProvidesProblemDetails;

    public function __construct(
        public readonly string $nodeId,
        public readonly ?int $expectedStateVersion = null,
        public readonly ?int $actualStateVersion = null,
    ) {
        parent::__construct($expectedStateVersion === null
            ? sprintf(
                '[Vaulter] Document %s already has a collaboration state; the seed was not written. Why: another hub instance seeded it first. Fix: reload the document state. Docs: %s',
                $nodeId,
                self::docs('collaboration-seed-conflict'),
            )
            : sprintf(
                '[Vaulter] Document %s changed after the hub loaded it (state version %d, now %s); the seed was not written. Why: it was updated between collab/load and the seed. Fix: load the document again and seed from its current content. Docs: %s',
                $nodeId,
                $expectedStateVersion,
                $actualStateVersion === null ? 'unknown' : (string) $actualStateVersion,
                self::docs('collaboration-seed-conflict'),
            ));
    }

    public function problemCode(): string
    {
        return 'collaboration_seed_conflict';
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
        return ['context' => array_filter([
            'node_id' => $this->nodeId,
            'expected_state_version' => $this->expectedStateVersion,
            'actual_state_version' => $this->actualStateVersion,
        ], static fn (mixed $value): bool => $value !== null)];
    }

    #[Override]
    public function errorDescriptor(): ErrorDescriptor
    {
        return new ErrorDescriptor(code: CollaborationErrorCode::SeedConflict, category: ErrorCategory::Conflict, retryable: true);
    }
}
