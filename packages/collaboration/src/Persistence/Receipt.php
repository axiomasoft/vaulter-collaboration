<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Api;

/** The committed receipt row of one update id of a generation. */
#[Api]
final readonly class Receipt
{
    public function __construct(
        public string $documentId,
        public int $generation,
        public string $updateId,
        public int $seq,
        public string $sha256,
    ) {}
}
