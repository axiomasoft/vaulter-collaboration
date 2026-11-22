<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Providers;

use Closure;
use Illuminate\Contracts\Auth\Access\Authorizable;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Contracts\Container\Container;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\Log;
use Packman\Attributes\Internal;
use Vaulter\Collaboration\CollaborationSchedule;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\Drain\BackoffDrainWaiter;
use Vaulter\Collaboration\Drain\DrainWaiter;
use Vaulter\Collaboration\HostUserResolver as DefaultHostUserResolver;
use Vaulter\Collaboration\Revocation\ControlTransport;
use Vaulter\Collaboration\Revocation\Transports\HttpControlTransport;
use Vaulter\Collaboration\Revocation\Transports\NoControlTransport;
use Vaulter\Collaboration\Revocation\Transports\RedisControlTransport;
use Vaulter\Configuration\CompiledOptionsCache;
use Vaulter\Configuration\ScheduleFrequency;
use Vaulter\Documents\Access\CollaborationAccessPolicy;
use Vaulter\Documents\Configuration\DocumentsOptions;
use Vaulter\Modules\ModuleBindings;

/** The container wiring of the collaboration module ({@see CollaborationModule}): its configuration, the host-user seam and the room channel. */
#[Internal]
final class CollaborationRegistrar implements ModuleBindings
{
    public function register(Application $app): void
    {
        $app->bind(CollaborationOptions::class, static fn (Container $app): CollaborationOptions => self::options($app)->withContext($app->make(DocumentsOptions::class), is_string($url = $app->make('config')->get('app.url')) ? $url : null));
        $app->bind('vaulter.config_validator.collaboration', static fn (Container $app): Closure => static function () use ($app): void {
            $config = $app->make(CollaborationOptions::class);
            $config->assertDistinctHubSecrets();
            $config->hubTokenTtl();
            $config->hubClockSkew();
            $config->controlTransport();
            $config->mode();
            ScheduleFrequency::fromMap('vaulter-collaboration.schedule', $app->make('config')->get('vaulter-collaboration.schedule', []), CollaborationSchedule::KEYS);
        });
        $app->tag('vaulter.config_validator.collaboration', 'vaulter.config_validators');

        // The host-user resolver seam: the collaboration webhook resolves the
        // acting user by id through the host's auth user-provider. Bound to the
        // default DefaultHostUserResolver; a host (or a test) may swap it. Purely
        // collaboration machinery — core neither defines nor binds it (finding).
        $app->bind(HostUserResolver::class, DefaultHostUserResolver::class);

        // How a drain waits for the hub's checkpoint; a test binds a fake hub here.
        $app->bind(DrainWaiter::class, BackoffDrainWaiter::class);

        // How a control message reaches the hubs (control.transport); a test binds a recording transport here.
        $app->bind(ControlTransport::class, static fn (Container $app): ControlTransport => match ($app->make(CollaborationOptions::class)->controlTransport()) {
            'redis' => $app->make(RedisControlTransport::class),
            'http' => $app->make(HttpControlTransport::class),
            default => new NoControlTransport,
        });
    }

    public function boot(Application $app): void
    {
        $config = $app->make(CollaborationOptions::class);
        // Structural validation first, in every environment, before any production-risk classifier runs.
        $config->assertDistinctHubSecrets();
        $config->hubTokenTtl();
        $config->hubClockSkew();
        $config->controlTransport();
        $config->mode();
        ScheduleFrequency::fromMap('vaulter-collaboration.schedule', $app->make('config')->get('vaulter-collaboration.schedule', []), CollaborationSchedule::KEYS);
        if (!$app->environment('production') && ($config->hubJwtKeysViolation() !== null || $config->hubWebhookSecret() === null)) {
            Log::warning('[Vaulter] Collaboration requires a usable JWT key set and a different webhook secret.');
        }

        self::registerBroadcastChannel();
    }

    /**
     * Authorize the private collaboration room channel (channel_prefix.{id}). The
     * room id is a NODE id: a kind=document node authorizes through the
     * Vaulter-owned AccessResolver (Ability::View to connect at all; read-only vs
     * writable is encoded in the issued session, not the channel). The channel is
     * registered only while the module is active — the realtime channel is a separate opt-in over base
     * document editing — and preserves the broadcast authorization seam independently of the Hocuspocus room token.
     */
    private static function registerBroadcastChannel(): void
    {
        Broadcast::channel(
            app(CollaborationOptions::class)->channelPrefix().'.{roomId}',
            static fn (Authenticatable $user, int|string $roomId): bool => self::authorizeNodeRoom($user, $roomId),
        );
    }

    /**
     * Authorize a node room: the id resolves to a kind=document node the actor may at
     * least View (the access policy of the documents answers with the ordinary access resolver).
     */
    private static function authorizeNodeRoom(Authenticatable $user, int|string $roomId): bool
    {
        return $user instanceof Authorizable && app(CollaborationAccessPolicy::class)->canViewDocumentNode($user, $roomId);
    }

    private static function options(Container $app): CollaborationOptions
    {
        return CompiledOptionsCache::resolve($app, 'vaulter-collaboration', static fn (array $raw): CollaborationOptions => CollaborationOptions::fromArray($raw));
    }
}
