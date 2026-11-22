<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Packman\Attributes\Internal;
use Vaulter\Documents\Contracts\DocumentType;
use Vaulter\Documents\Data\Collaboration\CollaborationGrant;
use Vaulter\Drive\Enums\Access\Ability;

/**
 * A hub call's room as it stands now: the live document behind the token, the
 * caller's current highest ability on it (null: not even View), whether its drive is
 * active (an archived drive is read-only), whether the room may write at this moment, and
 * whether the token predates a change of rights of its drive (the rights above were
 * checked anyway; the hub renews such a session at once).
 */
#[Internal]
final readonly class HubRoom
{
    public function __construct(
        public ?DocumentType $type,
        public ?Ability $ability,
        public bool $writable,
        public bool $driveActive,
        public string $userId,
        public CollaborationGrant $grant,
        public bool $permissionsStale = false,
    ) {}

    public function mode(): string
    {
        return $this->writable ? 'rw' : 'ro';
    }
}
