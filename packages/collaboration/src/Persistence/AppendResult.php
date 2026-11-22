<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Api;
use Packman\Attributes\Internal;

/**
 * The committed receipt of an appended update: the generation, the update id, the log sequence it was given and the
 * sha256 of its payload. `$duplicate` is true when the update id already had this receipt (a retry after a lost
 * answer): nothing was written again. Built only after the append's transaction committed, so it is the ack of a
 * saved edit.
 */
#[Api]
final readonly class AppendResult
{
    #[Internal]
    public function __construct(
        public string $documentId,
        public int $generation,
        public string $updateId,
        public int $seq,
        public string $sha256,
        public bool $duplicate,
    ) {}

    /**
     * The protocol 2 ack.
     *
     * @return array{generation: int, update_id: string, seq: int, sha256: string, persisted: true}
     */
    public function ack(): array
    {
        return [
            'generation' => $this->generation,
            'update_id' => $this->updateId,
            'seq' => $this->seq,
            'sha256' => $this->sha256,
            'persisted' => true,
        ];
    }
}
