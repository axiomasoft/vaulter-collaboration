<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\Exceptions\CollaborationCheckpointConflictException;
use Vaulter\Collaboration\Exceptions\CollaborationDrainingException;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\Exceptions\CollaborationProtocolMismatchException;
use Vaulter\Collaboration\Exceptions\CollaborationSeedConflictException;
use Vaulter\Collaboration\Exceptions\CollaborationUpdateMismatchException;
use Vaulter\Collaboration\Exceptions\CollaborationUpdateTooLargeException;
use Vaulter\Http\Problems\ProblemCodeSource;
use Vaulter\Http\Problems\ProblemSpec;
use Vaulter\Http\Problems\ReceiptPolicy;
use Vaulter\Http\Problems\Retryable;

/**
 * The problem codes of the collaboration module: declared by its manifest, so they are in the catalogue only
 * while the opt-in module is active. A stable public contract, so a code is added here, in
 * lang/{en,ru}/problems.php and in the reference docs together.
 */
#[Internal]
final class CollaborationProblemCodes implements ProblemCodeSource
{
    public function translationNamespace(): string
    {
        return 'vaulter-collaboration';
    }

    public function codes(): array
    {
        return [
            // A lost checkpoint CAS: the hub takes a new lease and merges again.
            'collaboration_checkpoint_conflict' => new ProblemSpec(409, CollaborationCheckpointConflictException::class, Retryable::AfterRefetch),
            // A managed disable drains the log: the hub keeps the update and repeats it after the flag is released.
            'collaboration_draining' => new ProblemSpec(503, CollaborationDrainingException::class, Retryable::WithBackoff),
            'collaboration_epoch_mismatch' => new ProblemSpec(409, CollaborationEpochMismatchException::class, Retryable::AfterRefetch, ReceiptPolicy::Cacheable),
            // Protocol 2: a deployment mismatch and a refused update are answered the same however often they are sent.
            'collaboration_protocol_mismatch' => new ProblemSpec(409, CollaborationProtocolMismatchException::class),
            'collaboration_seed_conflict' => new ProblemSpec(409, CollaborationSeedConflictException::class, Retryable::AfterRefetch, ReceiptPolicy::Cacheable),
            // The host's configuration decides, not the request: waiting does not help and a receipt would outlive a config change.
            'collaboration_update_mismatch' => new ProblemSpec(422, CollaborationUpdateMismatchException::class),
            'collaboration_update_too_large' => new ProblemSpec(413, CollaborationUpdateTooLargeException::class),
        ];
    }
}
