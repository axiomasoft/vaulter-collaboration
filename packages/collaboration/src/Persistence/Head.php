<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;

/**
 * One head row of the update log (v_collaboration_heads): the last committed sequence of a document generation (HS),
 * the sequence and state version its last checkpoint covers (CS, CV), the compaction lease, the drain request and the
 * time the generation was closed.
 */
#[Internal]
final readonly class Head
{
    public function __construct(
        public string $documentId,
        public int $generation,
        public int $headSeq,
        public int $checkpointSeq,
        public int $checkpointVersion,
        public ?string $leaseToken,
        public ?string $leaseOwner,
        public ?Carbon $leaseExpiresAt,
        public ?Carbon $drainRequestedAt,
        public ?Carbon $retiredAt,
    ) {}

    /** Whether a compaction lease holds the generation at `$now`. */
    public function leased(Carbon $now): bool
    {
        return $this->leaseToken !== null && $this->leaseExpiresAt !== null && $this->leaseExpiresAt->greaterThan($now);
    }

    /** Whether `$token` is the lease that holds the generation at `$now`. */
    public function heldBy(string $token, Carbon $now): bool
    {
        return $this->leased($now) && hash_equals((string) $this->leaseToken, $token);
    }
}
