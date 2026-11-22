<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Testing\Fixtures;

use Illuminate\Foundation\Auth\User;
use Packman\Attributes\Internal;

/** The test user this addon ships with its Testing helpers; it owns its fixture instead of importing a core one. */
#[Internal]
final class CollaborationTestUser extends User
{
    protected $guarded = [];

    public $timestamps = false;

    private ?string $morphAlias = null;

    /** The morph class the host's grants name this fixture by, when it differs from the class name. */
    public function morphAs(string $type): static
    {
        $this->morphAlias = $type;

        return $this;
    }

    public function getMorphClass(): string
    {
        return $this->morphAlias ?? parent::getMorphClass();
    }
}
