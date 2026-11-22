<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation;

use Packman\Attributes\Internal;

/**
 * The pair of permission versions a room token was issued under, or the current pair of its drive: the version
 * of the drive (`drive:<id>`) and the version of every drive (`global`). A token whose pair is older than the current
 * one predates a change of rights; the rights are checked on every call anyway, the pair only tells the hub its
 * session is stale.
 */
#[Internal]
final readonly class PermissionVersion
{
    public function __construct(
        public int $drive,
        public int $global,
    ) {}

    /** The `permissions_version` claim of a token, or null when it is not exactly `{drive: int ≥ 0, global: int ≥ 0}`. */
    public static function fromClaim(mixed $claim): ?self
    {
        $claim = is_object($claim) ? get_object_vars($claim) : $claim;
        if (!is_array($claim) || count($claim) !== 2) {
            return null;
        }
        $drive = $claim['drive'] ?? null;
        $global = $claim['global'] ?? null;

        return is_int($drive) && is_int($global) && $drive >= 0 && $global >= 0 ? new self(drive: $drive, global: $global) : null;
    }

    /** @return array{drive: int, global: int} */
    public function toClaim(): array
    {
        return ['drive' => $this->drive, 'global' => $this->global];
    }

    /** Whether a change of rights happened since this pair: either version moved on. */
    public function olderThan(self $current): bool
    {
        return $this->drive < $current->drive || $this->global < $current->global;
    }
}
