<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Collaboration;

use Illuminate\Foundation\Application;
use Override;
use Vaulter\Collaboration\Tests\TestCase;

/**
 * Boots the package with the opt-in collaboration module ACTIVE (`vaulter.modules.collaboration`): the session and
 * hub routes are mounted, the driver capability is provided. Like every other switch of the module graph it is flipped
 * in `defineEnvironment()` — before the application and its routes boot — never in a test's `beforeEach()`.
 */
abstract class CollaborationEnabledTestCase extends TestCase
{
    /**
     * @param Application $app
     */
    #[Override]
    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);

        $app['config']->set('vaulter.modules.collaboration', true);
    }
}
