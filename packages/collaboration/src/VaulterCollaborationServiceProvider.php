<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Illuminate\Support\ServiceProvider;
use Override;
use Packman\Attributes\Api;
use Packman\Foundation\Concerns\RegistersPackageRegistrars;
use Packman\Foundation\Contracts\PackageRegistrar;
use Vaulter\Collaboration\Providers\CollaborationPackageRegistrar;
use Vaulter\Modules\OffersModules;

/**
 * Vaulter Collaboration — real-time Yjs collaboration log, hub verification, and revocation transport. Registers Packman facets and offers {@see CollaborationModule}.
 */
#[Api(since: '1.0')]
final class VaulterCollaborationServiceProvider extends ServiceProvider
{
    use OffersModules;
    use RegistersPackageRegistrars {
        RegistersPackageRegistrars::register as protected registerRegistrars;
        RegistersPackageRegistrars::boot as protected bootRegistrars;
    }

    /** @var list<class-string<PackageRegistrar>> */
    protected const array REGISTRARS = [
        CollaborationPackageRegistrar::class,
    ];

    #[Override]
    public function register(): void
    {
        if ($this->moduleProviderRegistered()) {
            return;
        }

        $this->registerRegistrars();
    }

    public function boot(): void
    {
        if ($this->moduleProviderBooted()) {
            return;
        }

        $this->loadTranslationsFrom(__DIR__.'/../resources/lang', 'vaulter-collaboration');
        $this->bootRegistrars();
        $this->markModuleProviderBooted();
    }
}
