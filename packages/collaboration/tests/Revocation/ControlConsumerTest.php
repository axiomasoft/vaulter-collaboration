<?php

declare(strict_types=1);

use Illuminate\Contracts\Redis\Factory;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Http\Client\Request;
use Illuminate\Redis\Connections\Connection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Packman\Config\Exceptions\InvalidConfiguration;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Persistence\LogTables;
use Vaulter\Collaboration\Revocation\ControlConsumer;
use Vaulter\Collaboration\Revocation\ControlTransport;
use Vaulter\Collaboration\Revocation\Transports\HttpControlTransport;
use Vaulter\Collaboration\Revocation\Transports\NoControlTransport;
use Vaulter\Collaboration\Revocation\Transports\PostgresListenNotifyTransport;
use Vaulter\Collaboration\Revocation\Transports\RedisControlTransport;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Collaboration\Tests\Support\RecordingControlTransport;
use Vaulter\Collaboration\Tests\Support\Revocation;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Contracts\Observability\MetricsRecorder;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Actions\Revisions\RestoreDocumentRevisionAction;
use Vaulter\Documents\Data\Revisions\RestoreDocumentRevisionInput;
use Vaulter\Documents\Facades\Documents;
use Vaulter\Drive\Access\AccessInvalidation;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Enums\Events\DriveEventType;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
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
    ['drive' => $this->drive, 'folder' => $this->folder, 'node' => $this->node, 'grant' => $this->grant] = Revocation::inheritedDocument();
    // The fixture's own grant was a change too; start from its delivery.
    Revocation::relayControl();
    $this->transport->messages = [];
});

/** @return list<string> the states of the control consumer's delivery rows */
function controlDeliveryStates(): array
{
    return DB::table(app(DatabaseOptions::class)->table(OutboxStore::DELIVERIES))->where('consumer_id', ControlConsumer::ID)->orderBy('outbox_seq')->pluck('state')->all();
}

it('is an ephemeral consumer of control events', function (): void {
    $ids = array_map(static fn (SlotContribution $contribution): string => $contribution->id, app(Kernel::class)->extensions()->contributions(OutboxConsumer::class));
    $consumer = app(ControlConsumer::class);

    expect($ids)->toContain(ControlConsumer::ID)
        ->and($consumer->id())->toBe(ControlConsumer::ID)
        ->and($consumer->deliveryClass())->toBe(DeliveryClass::Ephemeral)
        ->and($consumer->subscribes(DriveEventType::EffectivePermissionsChanged))->toBeTrue()
        ->and($consumer->subscribes(DriveEventType::GrantRevoked))->toBeTrue()
        ->and($consumer->subscribes(DriveEventType::DriveArchived))->toBeFalse();
});

it('addresses a grant revocation to the affected subject in that drive', function (): void {
    $this->drive->access()->revoke($this->folder->id, $this->grant);
    Revocation::relayControl();

    expect($this->transport->messages)->toContain([
        'v' => 1, 'type' => 'revoke_subject', 'drive_id' => (string) $this->node->drive_id, 'scope' => 'drive',
        'subject_id' => '1', 'subject_type' => Revocation::subject()->type,
    ]);
});

it('closes the previous room after a restore', function (): void {
    $node = Hub::document();
    $previous = Hub::room($node);
    app(RestoreDocumentRevisionAction::class)->execute(
        DocumentTestHelpers::context($node, actorId: 1),
        new RestoreDocumentRevisionInput(node: $node, revision: DocumentTestHelpers::head($node)),
    );
    Revocation::relayControl();

    expect(array_values(array_filter($this->transport->messages, static fn (array $message): bool => ($message['type'] ?? null) === 'epoch_bump_4409')))
        ->toBe([['v' => 1, 'type' => 'epoch_bump_4409', 'room' => $previous]]);
});

it('closes a room when a content update advances its generation', function (): void {
    $node = Hub::document();
    $previous = Hub::room($node);
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    Hub::call('append', Hub::seedBody($node, 'room-state'), Hub::token($node))->assertOk();
    Compaction::publish(Compaction::leaseOf($node));
    $handle = Vaulter::drive($node->storage()->firstOrFail())->actingAs(AccessTestHelpers::user(1));
    Documents::in($handle)->update($node->id, Hub::tiptap('Replacement'));
    Revocation::relayControl();
    expect(array_column($this->transport->messages, 'type'))->not->toContain('epoch_bump_4409');

    Hub::session($node)->assertCreated()->assertJsonPath('data.generation', 1);
    Revocation::relayControl();
    expect($this->transport->messages)->toContain(['v' => 1, 'type' => 'epoch_bump_4409', 'room' => $previous]);
});

it('hands off only a superseded owner fence', function (): void {
    $node = Hub::document();
    config()->set('vaulter-collaboration.strict_profile', true);
    $database = app(VaulterDatabase::class);
    $database->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $room = Hub::room($node);
    Hub::call('authenticate', ['room' => $room, 'strict_capable' => true], Hub::token($node))->assertOk();
    $id = (string) Hub::aggregate($node)->getKey();
    $address = ['document_id' => $id, 'generation' => 0, 'owner_id' => (string) Str::uuid()];
    Hub::callV2('ownership/acquire', $address, null)->assertOk()->assertJsonPath('owner_fence', 1);
    Hub::callV2('ownership/renew', $address + ['owner_fence' => 1], null)->assertOk();
    expect($this->transport->messages)->toBe([]);

    $database->write(fn () => app(LogTables::class)->rows('collaboration_heads', $id, 0)
        ->update(['owner_expires_at' => now()->subMinute()]));
    $next = [...$address, 'owner_id' => (string) Str::uuid()];
    Hub::callV2('ownership/acquire', $next, null)->assertOk()->assertJsonPath('owner_fence', 2);
    expect($this->transport->messages)->toBe([['v' => 1, 'type' => 'handoff_request', 'room' => $room, 'owner_fence' => 1]]);
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
        ->and($transport('postgres'))->toBeInstanceOf(PostgresListenNotifyTransport::class)
        ->and($transport('http'))->toBeInstanceOf(HttpControlTransport::class)
        ->and($transport('none'))->toBeInstanceOf(NoControlTransport::class)
        ->and(fn (): ControlTransport => $transport('kafka'))->toThrow(InvalidConfiguration::class);
});

it('signs the payload of a PostgreSQL control notification', function (): void {
    $transport = app(PostgresListenNotifyTransport::class);
    if (app(VaulterDatabase::class)->driver() !== 'pgsql') {
        expect(fn () => $transport->publish('{"v":1}'))->toThrow(RuntimeException::class, 'requires PostgreSQL');

        return;
    }
    $notifications = [];
    DB::listen(static function (QueryExecuted $query) use (&$notifications): void {
        if ($query->sql === 'SELECT pg_notify(?, ?)') {
            $notifications[] = $query->bindings;
        }
    });
    $body = '{"v":1,"type":"epoch_bump_4409","room":"vaulter.documents.1.42.0"}';
    $transport->publish($body);

    expect($notifications)->toHaveCount(1);
    [$channel, $notification] = $notifications[0];
    $signed = json_decode($notification, true, flags: JSON_THROW_ON_ERROR);
    expect($channel)->toBe(PostgresListenNotifyTransport::CHANNEL)
        ->and($signed['body'])->toBe($body)
        ->and($signed['signature'])->toBe(CollaborationCallResolver::signature($body, Hub::WEBHOOK_SECRET, (int) $signed['timestamp']));
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
