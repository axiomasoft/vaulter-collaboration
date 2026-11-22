<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Illuminate\Contracts\Auth\Access\Authorizable;
use Illuminate\Contracts\Auth\Factory as AuthFactory;
use Illuminate\Database\Eloquent\Model;
use Packman\Attributes\Internal;
use Vaulter\ValueObjects\Access\Actor;
use Vaulter\ValueObjects\Access\ActorRef;

/** Resolves only the trusted auth provider model and checks its complete morph identity. */
#[Internal]
final readonly class HostUserResolver implements Contracts\HostUserResolver
{
    public function __construct(
        private AuthFactory $auth,
    ) {}

    public function find(ActorRef $principal): ?Authorizable
    {
        $guard = $this->auth->guard();

        // The base Guard contract does not declare getProvider(); the concrete guards
        // (Session/Token/RequestGuard) do via GuardHelpers, but a custom guard may not.
        if (!method_exists($guard, 'getProvider')) {
            return null;
        }

        $provider = $guard->getProvider();
        // Only the model configured by the trusted host provider may be materialised.
        if (!method_exists($provider, 'getModel')) {
            return null;
        }
        $model = $provider->getModel();
        if (!is_string($model) || !is_a($model, Model::class, true)) {
            return null;
        }
        $expected = new $model;
        if ($principal->id === null || $principal->type !== $expected->getMorphClass()) {
            return null;
        }
        $user = $provider->retrieveById($principal->id);
        if (!$user instanceof Authorizable) {
            return null;
        }
        $resolved = Actor::user($user)->ref();

        return $resolved->type === $principal->type && (string) $resolved->id === (string) $principal->id ? $user : null;
    }
}
