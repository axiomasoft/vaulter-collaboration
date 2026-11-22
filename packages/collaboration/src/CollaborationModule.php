<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Packman\Attributes\Api;
use Packman\Doctor\Contracts\DoctorCheck;
use Packman\Extensions\Concerns\Composition\ContributesToSlots;
use Packman\Extensions\Concerns\Configuration\Configurable;
use Packman\Extensions\Concerns\Persistence\OwnsSchema;
use Packman\Extensions\Concerns\Runtime\ProvidesDiagnostics;
use Packman\Extensions\Contracts\Composition\WithSlots;
use Packman\Extensions\Contracts\Configuration\WithConfiguration;
use Packman\Extensions\Contracts\Persistence\WithSchema;
use Packman\Extensions\Contracts\Runtime\WithDiagnostics;
use Packman\Plugins\Contracts\Registry\ExtensionPlugin;
use Packman\Plugins\Data\Plugin\PluginManifest;
use Packman\Plugins\Laravel\PluginRegistrar;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Console\DrainCommand;
use Vaulter\Collaboration\Console\PruneGenerationsCommand;
use Vaulter\Collaboration\Doctor\CollaborationCheck;
use Vaulter\Collaboration\Drain\HubDrainer;
use Vaulter\Collaboration\Drain\PendingRemovalGuard;
use Vaulter\Collaboration\Errors\CollaborationProblemDefinitions;
use Vaulter\Collaboration\Http\Support\CollaborationRouteLabels;
use Vaulter\Collaboration\Operations\CollaborationOperationPolicies;
use Vaulter\Collaboration\Persistence\GenerationCloser;
use Vaulter\Collaboration\Providers\CollaborationRegistrar;
use Vaulter\Collaboration\Revocation\ControlConsumer;
use Vaulter\Collaboration\Revocation\PermissionVersionSink;
use Vaulter\Collaboration\Schema\CollaborationSchema;
use Vaulter\Collaboration\Schema\CollaborationSchemaSets;
use Vaulter\Collaboration\Security\HubUrlInvariant;
use Vaulter\Collaboration\Security\SecretsInvariant;
use Vaulter\Contracts\Routing\RouteLabelSource;
use Vaulter\Contracts\Security\ProductionInvariant;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\State\PendingStateDrainer;
use Vaulter\Events\EventSink;
use Vaulter\Events\Outbox\OutboxConsumer;
use Vaulter\Modules\Activation;
use Vaulter\Modules\GuardsRemoval;
use Vaulter\Modules\PluginModuleSpec;
use Vaulter\Modules\WithModuleRuntime;

/** Native code plugin for the collaboration package. */
#[Api(since: '1.0')]
final class CollaborationModule implements ExtensionPlugin, GuardsRemoval, WithConfiguration, WithDiagnostics, WithModuleRuntime, WithSchema, WithSlots
{
    use Configurable;
    use ContributesToSlots;
    use OwnsSchema;
    use ProvidesDiagnostics;

    public function manifest(): PluginManifest
    {
        return new PluginManifest(id: 'vaulter.collaboration', version: '1.0.0', requires: ['vaulter.core', 'vaulter.drive', 'vaulter.documents'], resourceRoot: dirname(__DIR__).'/resources');
    }

    public function register(PluginRegistrar $registrar): void {}

    public function configRoot(): string
    {
        return 'vaulter-collaboration';
    }

    public function defaultConfigPath(): string
    {
        return dirname(__DIR__).'/config/vaulter-collaboration.php';
    }

    public function optionsClass(): string
    {
        return CollaborationOptions::class;
    }

    public function moduleRuntime(): PluginModuleSpec
    {
        return new PluginModuleSpec(plugin: self::class, activation: Activation::OptIn,
            routes: [dirname(__DIR__).'/routes/collaboration.php'], translations: ['vaulter-collaboration' => dirname(__DIR__).'/resources/lang'], commands: [PruneGenerationsCommand::class, DrainCommand::class], schedules: [CollaborationSchedule::class], bindings: [CollaborationRegistrar::class],
            problems: [CollaborationProblemCodes::class],
            operations: [CollaborationOperationPolicies::class],
            removalGuard: PendingRemovalGuard::class,
        );
    }

    public function tablePrefix(): string
    {
        return 'v_';
    }

    /** @return list<string> */
    public function tableNouns(): array
    {
        return ['collaboration_updates', 'collaboration_receipts', 'collaboration_heads', 'collaboration_permission_versions'];
    }

    public function migrationPath(): string
    {
        return dirname(__DIR__).'/database/migrations';
    }

    /** @return list<class-string> */
    public function schemaSetProviders(): array
    {
        return [CollaborationSchemaSets::class];
    }

    /** @return list<class-string> */
    public function schemaComponents(): array
    {
        return [CollaborationSchema::class];
    }

    public static function removalGuard(): string
    {
        return PendingRemovalGuard::class;
    }

    /** @return list<array{slot: class-string, id: string, implementation: class-string, priority?: int, key?: string|null}> */
    public function slotContributions(): array
    {
        return [
            ['slot' => RouteLabelSource::class, 'id' => 'collaboration.routes', 'implementation' => CollaborationRouteLabels::class],
            ['slot' => DoctorCheck::class, 'id' => 'collaboration.hub', 'implementation' => CollaborationCheck::class, 'key' => 'collaboration.hub'],
            ['slot' => ProductionInvariant::class, 'id' => 'collaboration.secrets', 'implementation' => SecretsInvariant::class, 'key' => 'collaboration.secrets'],
            ['slot' => ProductionInvariant::class, 'id' => 'collaboration.hub-url', 'implementation' => HubUrlInvariant::class, 'key' => 'collaboration.hub-url'],
            ['slot' => EventSink::class, 'id' => 'collaboration.generations', 'implementation' => GenerationCloser::class],
            ['slot' => EventSink::class, 'id' => PermissionVersionSink::ID, 'implementation' => PermissionVersionSink::class],
            ['slot' => OutboxConsumer::class, 'id' => ControlConsumer::ID, 'implementation' => ControlConsumer::class],
            ['slot' => CollaborationProtocolDriver::class, 'id' => 'collaboration.protocol.yjs', 'implementation' => HocuspocusCollaborationDriver::class, 'key' => 'yjs'],
            ['slot' => PendingStateDrainer::class, 'id' => 'collaboration.pending.yjs', 'implementation' => HubDrainer::class, 'key' => 'yjs'],
        ];
    }

    /** @return list<class-string> */
    public function healthChecks(): array
    {
        return [CollaborationCheck::class];
    }

    /** @return list<class-string> */
    public function problemProviders(): array
    {
        return [CollaborationProblemDefinitions::class];
    }
}
