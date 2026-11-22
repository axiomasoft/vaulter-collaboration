<?php

declare(strict_types=1);

use Illuminate\Contracts\Console\Kernel as ConsoleKernel;
use Illuminate\Foundation\Application;
use Illuminate\Routing\Route;
use Packman\Extensions\Concerns\Composition\ContributesToSlots;
use Packman\Extensions\Contracts\Composition\WithSlots;
use Packman\Plugins\Contracts\Registry\ExtensionPlugin;
use Packman\Plugins\Data\Plugin\PluginManifest;
use Packman\Plugins\Laravel\PluginRegistrar;
use Vaulter\Collaboration\CollaborationModule;
use Vaulter\Collaboration\CollaborationSchedule;
use Vaulter\Collaboration\Console\DrainCommand;
use Vaulter\Collaboration\Console\PruneGenerationsCommand;
use Vaulter\Collaboration\Drain\HubDrainer;
use Vaulter\Collaboration\Drain\PendingRemovalGuard;
use Vaulter\Collaboration\HocuspocusCollaborationDriver;
use Vaulter\Collaboration\Operations\CollaborationOperations;
use Vaulter\Collaboration\Schema\CollaborationSchema;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\State\PendingStateDrainer;
use Vaulter\Events\EventSink;
use Vaulter\Http\Middleware\EnsureModuleActive;
use Vaulter\Http\Problems\ProblemCatalog;
use Vaulter\Kernel;
use Vaulter\Modules\Activation;
use Vaulter\Modules\GuardsRemoval;
use Vaulter\Modules\InvalidModuleGraph;
use Vaulter\Modules\ModuleCompiler;
use Vaulter\Modules\ModuleDeclarations;
use Vaulter\Modules\ModuleId;
use Vaulter\Modules\ModuleState;
use Vaulter\Modules\PluginModuleSpec;
use Vaulter\Modules\SlotContribution;
use Vaulter\Modules\WithModuleRuntime;
use Vaulter\Testing\Concerns\FreshApplication;

/**
 * The collaboration module: opt-in, so a host that installed the package and did not switch it on has no routes,
 * no driver and no operations of it; a host that did has the session and hub routes behind the module middleware,
 * the transport capability of the documents module and the problem codes, and nothing of it without its dependency.
 */

/** @return list<Route> the routes of the collaboration module */
function collaborationRoutes(Application $app): array
{
    return array_values(array_filter(
        $app['router']->getRoutes()->getRoutes(),
        static fn (Route $route): bool => in_array(EnsureModuleActive::ALIAS.':collaboration', $route->middleware(), true),
    ));
}

function collaborationState(Application $app): ModuleState
{
    return array_values(array_filter($app->make(Kernel::class)->modules(), static fn (ModuleState $state): bool => $state->id->value === 'collaboration'))[0];
}

it('declares an opt-in manifest that needs the documents module', function (): void {
    $module = new CollaborationModule;
    $builder = ModuleDeclarations::buildOffered(CollaborationModule::class);

    expect($module->manifest()->id)->toBe('vaulter.collaboration')
        ->and($module->moduleRuntime()->activation)->toBe(Activation::OptIn)
        ->and($module->manifest()->requires)->toBe(['vaulter.core', 'vaulter.drive', 'vaulter.documents'])
        ->and(array_keys($builder->configs()))->toBe(['vaulter-collaboration'])
        ->and($module->schemaComponents()[0])->toBe(CollaborationSchema::class)
        ->and(array_map(realpath(...), $builder->schemaPaths()))->toBe([realpath(__DIR__.'/../../database/migrations')])
        ->and(array_map(realpath(...), $builder->routeFiles()))->toBe([realpath(__DIR__.'/../../routes/collaboration.php')])
        ->and($builder->capabilityProviders())->toBe([])
        ->and(array_values(array_map(static fn (SlotContribution $c): string => $c->key ?? '', array_filter($builder->contributions(), static fn (SlotContribution $c): bool => in_array($c->slot, [CollaborationProtocolDriver::class, PendingStateDrainer::class], true)))))->toBe(['yjs', 'yjs'])
        ->and($builder->commandClasses())->toBe([PruneGenerationsCommand::class, DrainCommand::class])
        ->and($builder->schedules())->toBe([CollaborationSchedule::class])
        // Read statically by vaulter:module:uninstall, also while the module is off.
        ->and($module)->toBeInstanceOf(GuardsRemoval::class)
        ->and(CollaborationModule::removalGuard())->toBe(PendingRemovalGuard::class);
});

it('drains pending documents through the hub and closes the generations a restore leaves once it is switched on', function (): void {
    $app = FreshApplication::boot(['vaulter.modules.collaboration' => true]);
    $kernel = $app->make(Kernel::class);
    $sinks = array_map(static fn (SlotContribution $contribution): string => $contribution->id, $kernel->extensions()->contributions(EventSink::class));

    expect($kernel->extensions()->handler(PendingStateDrainer::class, 'yjs'))->toBeInstanceOf(HubDrainer::class)
        ->and($sinks)->toContain('collaboration.generations')
        ->and($app->make(ConsoleKernel::class)->all())->toHaveKey('vaulter:collaboration:prune')
        ->and($app->make(ConsoleKernel::class)->all())->toHaveKey('vaulter:collaboration:drain')
        ->and(FreshApplication::$queries)->toBe(0);
    $off = FreshApplication::boot();
    expect($off->make(Kernel::class)->extensions()->handlerKeys(PendingStateDrainer::class) !== [])->toBeFalse()
        ->and($off->make(ConsoleKernel::class)->all())->not->toHaveKey('vaulter:collaboration:drain');
});

it('stays off by default: no routes, no driver, no operations, and the host still serves its own requests', function (): void {
    $app = FreshApplication::boot();
    $kernel = $app->make(Kernel::class);

    expect($kernel->isValid())->toBeTrue()
        ->and($kernel->isActive('collaboration'))->toBeFalse()
        ->and(collaborationState($app)->activeReason)->toBe(ModuleState::REASON_DEFAULT)
        ->and(collaborationRoutes($app))->toBe([])
        ->and($app['router']->has('vaulter.v1.collaboration.hub.append'))->toBeFalse()
        // Neutral session issuance belongs to documents, even without a transport adapter.
        ->and($app['router']->has('vaulter.v1.documents.collaboration.session'))->toBeTrue()
        ->and($kernel->extensions()->handlerKeys(CollaborationProtocolDriver::class) !== [])->toBeFalse()
        ->and($app->bound(CollaborationOperations::class))->toBeFalse()
        ->and($app['config']->has('vaulter-collaboration'))->toBeTrue() // Installed Packman plugin defaults remain available.
        ->and(FreshApplication::$queries)->toBe(0);
});

it('mounts the session and the hub routes behind the module middleware once it is switched on', function (): void {
    $app = FreshApplication::boot(['vaulter.modules.collaboration' => true]);
    $kernel = $app->make(Kernel::class);

    expect($kernel->isValid())->toBeTrue()
        ->and($kernel->isActive('collaboration'))->toBeTrue()
        ->and(collaborationState($app)->activeReason)->toBe(ModuleState::REASON_OVERRIDE)
        ->and(array_map(static fn (Route $route): string => (string) $route->getName(), collaborationRoutes($app)))->toEqualCanonicalizing([
            'vaulter.v1.collaboration.hub.authenticate',
            'vaulter.v1.collaboration.hub.load',
            'vaulter.v1.collaboration.hub.append',
            'vaulter.v1.collaboration.hub.compaction.lease',
            'vaulter.v1.collaboration.hub.checkpoint',
            'vaulter.v1.collaboration.hub.renew',
            'vaulter.v1.collaboration.hub.recheck',
        ])
        ->and($kernel->extensions()->handler(CollaborationProtocolDriver::class, 'yjs'))->toBeInstanceOf(HocuspocusCollaborationDriver::class)
        ->and($app['config']->has('vaulter-collaboration.driver'))->toBeFalse()
        ->and(FreshApplication::$queries)->toBe(0);
});

it('activates nothing at all while the documents module it needs is switched off', function (): void {
    $app = FreshApplication::boot(['vaulter.modules' => ['collaboration' => true, 'documents' => false]]);
    $kernel = $app->make(Kernel::class);

    expect($kernel->isValid())->toBeFalse()
        ->and($kernel->reasons())->toContain('module "collaboration" is active but requires "documents", which is not active')
        ->and(collaborationRoutes($app))->toBe([])
        ->and($app->make(ConsoleKernel::class)->all())->toHaveKey('vaulter:modules');
});

it('keeps the problem codes of the collaboration concept out of the catalogue while the module is off', function (): void {
    $off = FreshApplication::boot()->make(ProblemCatalog::class);
    $on = FreshApplication::boot(['vaulter.modules.collaboration' => true])->make(ProblemCatalog::class);

    foreach (['collaboration_epoch_mismatch', 'collaboration_seed_conflict', 'collaboration_checkpoint_conflict', 'collaboration_draining'] as $code) {
        expect($off->has($code))->toBeFalse($code)
            ->and($on->has($code))->toBeTrue($code)
            ->and($on->module($code))->toBe('collaboration')
            ->and($on->title($code, 'en'))->not->toBeNull()
            ->and($on->title($code, 'ru'))->not->toBeNull();
    }
});

it('rejects duplicate protocol handler keys before resolving transports', function (): void {
    $modules = array_map(static fn (ModuleState $state): object => new $state->manifest, FreshApplication::boot(['vaulter.modules.collaboration' => true])->make(Kernel::class)->modules());
    $modules[] = new class implements ExtensionPlugin, WithModuleRuntime, WithSlots
    {
        use ContributesToSlots;

        public function manifest(): PluginManifest
        {
            return new PluginManifest(id: 'vaulter.'.$this->id()->value, version: '1.0.0', requires: array_map(static fn (string $id): string => 'vaulter.'.$id, array_keys($this->requires())));
        }

        public function register(PluginRegistrar $registrar): void {}

        public function moduleRuntime(): PluginModuleSpec
        {
            return new PluginModuleSpec(plugin: self::class, protocolVersion: $this->version(), requires: $this->requires());
        }

        public function id(): ModuleId
        {
            return new ModuleId('duplicate-yjs');
        }

        public function version(): string
        {
            return '1.0';
        }

        public function activation(): Activation
        {
            return Activation::Auto;
        }

        public function requires(): array
        {
            return ['documents' => '^1.0'];
        }

        public function slotContributions(): array
        {
            return [
                ['slot' => CollaborationProtocolDriver::class, 'implementation' => HocuspocusCollaborationDriver::class, 'id' => 'duplicate.protocol.yjs', 'key' => 'yjs'],
            ];
        }
    };
    $compiled = (new ModuleCompiler)->compile($modules, ['collaboration' => true]);
    expect($compiled)->toBeInstanceOf(InvalidModuleGraph::class);
});
