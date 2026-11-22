<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Testing\Fixtures;

use Illuminate\Contracts\Auth\Access\Authorizable;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Support\Identity;
use Vaulter\ValueObjects\Access\ActorRef;

/** CollaborationTestUser-only typed resolver; unknown IDs fail closed. */
#[Internal]
final class FakeHostUserResolver implements HostUserResolver
{
    /**
     * @param list<int|string> $unknownIds ids that resolve to null
     * @param string|null      $userType   the principal type the host grants its test users under; default: this fixture's own
     */
    public function __construct(
        private readonly array $unknownIds = [],
        private readonly ?string $userType = null,
    ) {}

    public function find(ActorRef $principal): ?Authorizable
    {
        $id = $principal->id;
        if ($principal->type !== ($this->userType ?? (new CollaborationTestUser)->getMorphClass()) || $id === null || in_array((string) $id, array_map(strval(...), $this->unknownIds), strict: true)) {
            return null;
        }

        $user = (new CollaborationTestUser)->morphAs($principal->type);
        $user->forceFill(['id' => Identity::key($id) ?? $id]);
        $user->exists = true;

        return $user;
    }
}
