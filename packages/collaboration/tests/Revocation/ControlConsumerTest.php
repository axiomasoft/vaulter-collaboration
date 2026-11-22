<?php

declare(strict_types=1);

use Illuminate\Contracts\Redis\Factory;
use Illuminate\Http\Client\Request;
use Illuminate\Redis\Connections\Connection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Packman\Config\Exceptions\InvalidConfiguration;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Revocation\ControlConsumer;
use Vaulter\Collaboration\Revocation\ControlTransport;
use Vaulter\Collaboration\Revocation\Transports\HttpControlTransport;
use Vaulter\Collaboration\Revocation\Transports\NoControlTransport;
use Vaulter\Collaboration\Revocation\Transports\RedisControlTransport;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\RecordingControlTransport;
use Vaulter\Collaboration\Tests\Support\Revocation;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Contracts\Observability\MetricsRecorder;
use Vaulter\Drive\Access\AccessInvalidation;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Enums\Events\DriveEventType;
use Vaulter\Events\Outbox\DeliveryClass;
use Vaulter\Events\Outbox\OutboxConsumer;
use Vaulter\Events\Outbox\OutboxStore;
use Vaulter\Kernel;
use Vaulter\Modules\SlotContribution;
use Vaulter\Testing\FakeMetricsRecorder;

/**
 * The control consumer collaboration.control (ephemeral): after a change of effective permissions commits, the
 * relay hands it to the configured transport as {v: 1, drive_id, scope, permissions_version, at}. A failure is logged
 * and counted, never retried; a message older than the token lifetime is dropped; `none` sends nothing.
 */
beforeEach(function (): void {
    Hub::configure();
    $this->app->instance(MetricsRecorder::class, new FakeMetricsRecorder);
    $this->transport = new RecordingControlTransport;
    $this->app->instance(ControlTransport::class, $this->transport);
    ['drive' => $this->drive, 'folder' => $this->folder, 'node' => $this->node] = Revocation::inheritedDocument();
    // The fixture's own grant was a change too; start from its delivery.
    Revocation::relayControl();
    $this->transport->messages = [];
});

/** @return list<string> the states of the control consumer's delivery rows */
function controlDeliveryStates(): array
{
    return DB::table(app(DatabaseOptions::class)->table(OutboxStore::DELIVERIES))->where('consumer_id', ControlConsumer::ID)->orderBy('outbox_seq')->pluck('state')->all();
}

it('is an ephemeral outbox consumer of the effective-permissions events only', function (): void {
    $ids = array_map(static fn (SlotContribution $contribution): string => $contribution->id, app(Kernel::class)->extensions()->contributions(OutboxConsumer::class));
    $consumer = app(ControlConsumer::class);

    expect($ids)->toContain(ControlConsumer::ID)
        ->and($consumer->id())->toBe(ControlConsumer::ID)
        ->and($consumer->deliveryClass())->toBe(DeliveryClass::Ephemeral)
        ->and($consumer->subscribes(DriveEventType::EffectivePermissionsChanged))->toBeTrue()
        ->and($consumer->subscribes(DriveEventType::GrantRevoked))->toBeFalse()
        ->and($consumer->subscribes(DriveEventType::DriveArchived))->toBeFalse();
});

it('tells the hubs of a drive change with the drive\'s version now', function (): void {
    $this->drive->archive();
    Revocation::relayControl();

    expect($this->transport->messages)->toHaveCount(1);
    $message = $this->transport->messages[0];
    expect(array_keys($message))->toBe(['v', 'drive_id', 'scope', 'permissions_version', 'at'])
        ->and($message['v'])->toBe(1)
        ->and($message['drive_id'])->toBe((string) $this->node->drive_id)
        ->and($message['scope'])->toBe('drive')
        ->and($message['permissions_version'])->toBe(Revocation::versions($this->node)->drive)
        ->and($message['at'])->toMatch('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/')
        ->and(controlDeliveryStates())->each->toBe('done');
    app(MetricsRecorder::class)->assertCounter('vaulter_collab_control_published_total', ['transport' => 'recording']);
});

it('tells the hubs of a change in a subtree and of a global change', function (): void {
    $this->drive->access()->grant($this->folder->id, new GrantInput(subject: Revocation::subject(5), role: RoleRegistry::READER));
    app(AccessInvalidation::class)->changed(null, 'host-role');
    Revocation::relayControl();

    $byScope = collect($this->transport->messages)->keyBy('scope');
    expect($byScope->keys()->sort()->values()->all())->toBe(['global', 'subtree'])
        ->and($byScope['subtree']['drive_id'])->toBe((string) $this->node->drive_id)
        ->and($byScope['subtree']['permissions_version'])->toBe(Revocation::versions($this->node)->drive)
        ->and($byScope['global']['drive_id'])->toBeNull()
        ->and($byScope['global']['permissions_version'])->toBe(Revocation::globalVersion());
});

it('logs and counts a failed message and finishes its delivery without a retry', function (): void {
    $this->transport->fail = true;
    Log::spy();

    $this->drive->archive();
    Revocation::relayControl();
    Revocation::relayControl();

    expect($this->transport->messages)->toBe([])
        ->and(controlDeliveryStates())->each->toBe('done');
    app(MetricsRecorder::class)->assertCounter('vaulter_collab_control_failures_total', ['transport' => 'recording']);
    Log::shouldHaveReceived('warning')->withArgs(static fn (string $message): bool => str_contains($message, 'control message was not delivered'))->once();
});

it('drops a change older than the token lifetime: no token it concerns is alive, so it is never replayed late', function (): void {
    $this->drive->archive();
    $this->travel(app(CollaborationOptions::class)->hubTokenTtl() + app(CollaborationOptions::class)->hubClockSkew() + 1)->seconds();
    Revocation::relayControl();

    expect($this->transport->messages)->toBe([])
        ->and(controlDeliveryStates())->each->toBe('done');
    app(MetricsRecorder::class)->assertCounter('vaulter_collab_control_stale_total');
});

it('stays active with the none transport and sends nothing', function (): void {
    config()->set('vaulter-collaboration.control.transport', 'none');
    $this->app->forgetInstance(ControlTransport::class);

    $this->drive->archive();
    Revocation::relayControl();

    expect(app(ControlTransport::class))->toBeInstanceOf(NoControlTransport::class)
        ->and(controlDeliveryStates())->each->toBe('done');
    app(MetricsRecorder::class)->assertCounter('vaulter_collab_control_published_total', ['transport' => 'none']);
});

it('selects the transport the configuration names', function (): void {
    $this->app->forgetInstance(ControlTransport::class);
    $transport = static function (string $name): ControlTransport {
        config()->set('vaulter-collaboration.control.transport', $name);

        return app(ControlTransport::class);
    };

    expect($transport('redis'))->toBeInstanceOf(RedisControlTransport::class)
        ->and($transport('http'))->toBeInstanceOf(HttpControlTransport::class)
        ->and($transport('none'))->toBeInstanceOf(NoControlTransport::class)
        ->and(fn (): ControlTransport => $transport('kafka'))->toThrow(InvalidConfiguration::class);
});

it('publishes on the vaulter:collab:control channel of the configured Redis connection', function (): void {
    config()->set('vaulter-collaboration.control.redis.connection', 'control');
    $connection = Mockery::mock(Connection::class);
    $connection->shouldReceive('command')->once()->with('publish', [RedisControlTransport::CHANNEL, '{"v":1}']);
    $redis = Mockery::mock(Factory::class);
    $redis->shouldReceive('connection')->once()->with('control')->andReturn($connection);

    new RedisControlTransport($redis, app(CollaborationOptions::class))->publish('{"v":1}');

    expect(RedisControlTransport::CHANNEL)->toBe('vaulter:collab:control');
});

it('posts a signed message to every hub, and fails after trying them all when one refuses', function (): void {
    config()->set('vaulter-collaboration.control.http.urls', 'http://hub-1:1235, http://hub-2:1235/');
    Http::fake([
        'hub-1:1235/control' => Http::response(null, 204),
        'hub-2:1235/control' => Http::response(['error' => 'down'], 503),
    ]);

    expect(fn () => app(HttpControlTransport::class)->publish('{"v":1}'))->toThrow(RuntimeException::class, 'reached 1 of 2 hubs');

    Http::assertSentCount(2);
    Http::assertSent(static function (Request $request): bool {
        $timestamp = (int) $request->header(CollaborationCallResolver::TIMESTAMP_HEADER)[0];

        return $request->body() === '{"v":1}'
            && $request->header(CollaborationCallResolver::SIGNATURE_HEADER)[0] === CollaborationCallResolver::signature('{"v":1}', Hub::WEBHOOK_SECRET, $timestamp);
    });
});

it('refuses to post without hubs to post to', function (): void {
    config()->set('vaulter-collaboration.control.http.urls', []);
    Http::fake();

    expect(fn () => app(HttpControlTransport::class)->publish('{"v":1}'))->toThrow(RuntimeException::class, 'names no hub');
    Http::assertNothingSent();
});
