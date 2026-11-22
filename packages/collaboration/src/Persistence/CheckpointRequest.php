<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Internal;
use Vaulter\Documents\State\CollaborationStateBinding;

/**
 * A checkpoint the hub merged under a compaction lease: the binary Yjs state of the checkpoint (C) the lease read with
 * the updates (C, H] applied, and its JSON projection. `$expectedCheckpointVersion` is the checkpoint version the lease
 * reported; `$coveredFrom` and `$coveredThrough` are C and H.
 */
#[Internal]
final readonly class CheckpointRequest
{
    /** @param array<string, mixed> $content */
    public function __construct(
        public string $nodeId,
        public int $generation,
        public string $leaseToken,
        public int $coveredFrom,
        public int $coveredThrough,
        public int $expectedCheckpointVersion,
        public string $state,
        public array $content,
        public CollaborationStateBinding $binding,
        public string $documentType,
    ) {}
}
