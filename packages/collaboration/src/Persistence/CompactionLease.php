<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Illuminate\Support\Carbon;
use Packman\Attributes\Api;

/**
 * A compaction lease on one document generation and what the hub merges under it, read in the transaction that
 * granted it: the checkpoint and the tail (C, H] of `$log`, and the checkpoint version CV the publication must expect.
 * The hub publishes with covered_from = `$log->checkpointSeq`, covered_through ≤ `$leaseThroughSeq` and this token before
 * `$expiresAt`.
 */
#[Api]
final readonly class CompactionLease
{
    public function __construct(
        public string $nodeId,
        public string $protocol,
        public string $token,
        public Carbon $expiresAt,
        public int $checkpointVersion,
        public int $leaseThroughSeq,
        public LogSnapshot $log,
    ) {}

    /** The bytes of state the entry carries to the hub (its checkpoint and tail, as stored). */
    public function bytes(): int
    {
        $bytes = strlen($this->log->checkpoint ?? '');
        foreach ($this->log->tail as $update) {
            $bytes += strlen($update['payload']);
        }

        return $bytes;
    }
}
