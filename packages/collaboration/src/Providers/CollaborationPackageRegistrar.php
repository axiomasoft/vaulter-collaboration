<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Providers;

use Illuminate\Contracts\Foundation\Application;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use Packman\Foundation\Contracts\PackageRegistrar;
use Vaulter\Collaboration\CollaborationModule;
use Vaulter\Laravel\VaulterPluginRegistrar;

/** Registers the native plugin and its Vaulter domain runtime. */
#[Spi(kind: SpiKind::Call, since: '1.0')]
final class CollaborationPackageRegistrar implements PackageRegistrar
{
    public function register(Application $app): void
    {
        VaulterPluginRegistrar::register($app, CollaborationModule::class, dirname(__DIR__, 2).'/composer.json');
    }

    public function boot(Application $app): void {}
}
