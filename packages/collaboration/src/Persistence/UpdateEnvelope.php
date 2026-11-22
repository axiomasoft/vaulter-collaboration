<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use InvalidArgumentException;
use Packman\Attributes\Internal;

/**
 * One Yjs update as protocol 2 carries it: the generation it was made in, the stable id its origin gave it (repeated
 * unchanged on every retry), the decoded binary payload and the sha256 the origin claims for it. The claimed hash is
 * checked against the payload, never trusted.
 *
 * `$seedStateVersion` marks the hub's seed — the Y.Doc it built from the document's JSON — with the state version that
 * JSON had: it is appended only as the first record of a generation without checkpoint, while the state version still
 * holds, so two hubs never both seed and a seed never overwrites newer JSON.
 */
#[Internal]
final readonly class UpdateEnvelope
{
    public function __construct(
        public int $generation,
        public string $updateId,
        public string $payload,
        public string $claimedSha256,
        public string $origin = 'client',
        public ?int $seedStateVersion = null,
    ) {
        if ($generation < 0) {
            throw new InvalidArgumentException('[Vaulter] An update names a generation of at least 0.');
        }
        if ($payload === '') {
            throw new InvalidArgumentException('[Vaulter] An update carries a payload.');
        }
        if ($seedStateVersion !== null && $seedStateVersion < 0) {
            throw new InvalidArgumentException('[Vaulter] A seed names a state version of at least 0.');
        }
    }

    /** The hash of the payload, computed here. */
    public function sha256(): string
    {
        return hash('sha256', $this->payload);
    }
}
