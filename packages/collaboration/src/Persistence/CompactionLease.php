<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;

/**
 * A compaction lease on one document generation and what the hub merges under it, read in the transaction that
 * granted it: the checkpoint and the tail (C, H] of `$log`, and the checkpoint version CV the publication must expect.
 * The hub publishes with covered_from = `$log->checkpointSeq`, covered_through ≤ `$log->headSeq` and this token before
 * `$expiresAt`.
 */
#[Internal]
final readonly class CompactionLease
{
    public function __construct(
        public string $nodeId,
        public string $token,
        public Carbon $expiresAt,
        public int $checkpointVersion,
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
