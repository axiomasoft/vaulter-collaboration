<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Internal;
use Vaulter\Documents\State\CollaborationStateBinding;

/**
 * What a hub replays a room from (protocol 2 load), read under the document and head locks so the parts agree: the
 * document's binary checkpoint (null before the first one), the log sequence it covers (C), the head (H) and the
 * committed updates (C, H] in order, their payload base64 as stored. The type, schema version and stored JSON come from
 * the same locked row as the state version, so a seed before the first checkpoint matches the version it is reported with.
 */
#[Internal]
final readonly class LogSnapshot
{
    /**
     * @param array<string, mixed>|null                                 $content
     * @param list<array{seq: int, update_id: string, payload: string}> $tail
     */
    public function __construct(
        public string $documentId,
        public int $generation,
        public int $stateVersion,
        public string $type,
        public int $schemaVersion,
        public ?array $content,
        public ?string $checkpoint,
        public int $checkpointSeq,
        public int $headSeq,
        public array $tail,
        public CollaborationStateBinding $binding,
    ) {}
}
