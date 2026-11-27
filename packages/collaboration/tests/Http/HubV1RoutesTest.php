<?php

declare(strict_types=1);

use Illuminate\Http\Request;
use Illuminate\Routing\Route;
use Illuminate\Support\Facades\Route as Router;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Http\Middleware\ResolveCollaborationCall;
use Vaulter\Collaboration\Http\Middleware\TraceCollaborationCall;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Persistence\CommandActor;
use Vaulter\Collaboration\Persistence\CommandJournal;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Contracts\Observability\TraceRecorder;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\Http\Middleware\VaulterHttpOperationMap;
use Vaulter\Http\Middleware\VaulterThrottledRouteMap;
use Vaulter\Observability\OtlpOpenTelemetryTraceRecorder;
use Vaulter\ValueObjects\Access\Actor;

/**
 * The hub's server-to-server calls on their own stack: a room JWT and a body signature
 * instead of a session, problem+json on every refusal, and the epoch fence's 409 stays
 * terminal. The protocol itself (load, seed, append, fences) is HubProtocolTest.
 */
beforeEach(function (): void {
    Hub::configure();
});

it('serves authenticate, load and append under the v1 hub names, and no full-state store', function (): void {
    $node = Hub::document();
    $token = Hub::token($node);

    Hub::call('authenticate', ['room' => Hub::room($node)], $token)->assertOk()->assertJsonPath('allowed', true)->assertJsonPath('mode', 'rw');
    Hub::call('load', ['room' => Hub::room($node)], $token)->assertOk()->assertJsonPath('type', 'vaulter/rich-text');
    Hub::call('append', Hub::seedBody($node, 'state'), $token)->assertOk()->assertJsonPath('persisted', true);

    $names = collect(Router::getRoutes()->getRoutes())->map(fn (Route $route): ?string => $route->getName())->filter()->values()->all();
    expect($names)->toContain('vaulter.v1.collaboration.hub.authenticate', 'vaulter.v1.collaboration.hub.load', 'vaulter.v1.collaboration.hub.append')
        ->and($names)->not->toContain('vaulter.v1.collaboration.hub.store');
    $this->postJson(Docs::url('collaboration/hub/store'), ['room' => Hub::room($node)])->assertNotFound();
});

it('refuses an unsigned or token-less call 401 as problem+json', function (string $endpoint): void {
    $node = Hub::document();
    $body = Hub::appendBody($node, 'x');

    $this->postJson(Docs::url('collaboration/hub/'.$endpoint), $body)
        ->assertStatus(401)
        ->assertHeader('Content-Type', 'application/problem+json')
        ->assertJsonPath('code', 'actor_required')
        ->assertJsonMissingPath('message');
    // A valid token without the body signature is no better.
    $this->postJson(Docs::url('collaboration/hub/'.$endpoint), $body, ['Authorization' => 'Bearer '.Hub::token($node)])->assertStatus(401);
})->with(['authenticate', 'load', 'append']);

it('refuses an append from a past generation with the terminal 409 and a read-only token with 403', function (): void {
    $node = Hub::document();
    $stale = Hub::token($node, epoch: 0);
    app(VaulterDatabase::class)->write(fn () => Hub::aggregate($node)->forceFill(['collab_epoch' => 1])->save());

    Hub::call('append', Hub::appendBody($node, 'late', generation: 0), $stale)
        ->assertStatus(409)
        ->assertHeader('Content-Type', 'application/problem+json')
        ->assertJsonPath('code', 'collaboration_epoch_mismatch');

    $fresh = Hub::document();
    Hub::call('append', Hub::appendBody($fresh, 'ro'), Hub::token($fresh, mode: 'ro'))->assertForbidden()->assertJsonPath('code', 'permission_denied');
});

it('answers a malformed append body 422 validation_failed after the room was opened', function (): void {
    $node = Hub::document();

    Hub::call('append', ['room' => Hub::room($node)], Hub::token($node))->assertStatus(422)->assertJsonPath('code', 'validation_failed')->assertJsonValidationErrors(['generation', 'update_id', 'sha256', 'payload']);
    Hub::call('append', ['payload' => '***'] + Hub::appendBody($node, 'x'), Hub::token($node))->assertStatus(422)->assertJsonValidationErrors('payload');
    Hub::call('append', ['seed_state_version' => -1] + Hub::appendBody($node, 'x'), Hub::token($node))->assertStatus(422)->assertJsonValidationErrors('seed_state_version');
});

it('does not take a user session for a hub call, and the session routes are not on the hub stack', function (): void {
    $node = Hub::document();
    $this->actingAs(AccessTestHelpers::user(1));

    $this->postJson(Docs::url('collaboration/hub/authenticate'), ['room' => Hub::room($node)])->assertStatus(401);

    $hub = Router::getRoutes()->getByName('vaulter.v1.collaboration.hub.append');
    $content = Router::getRoutes()->getByName('vaulter.v1.documents.content.update');
    expect($hub->middleware())->toContain('throttle:vaulter-public')
        ->and($hub->gatherMiddleware())->toContain(ResolveCollaborationCall::class)
        ->and($content->gatherMiddleware())->not->toContain(ResolveCollaborationCall::class)
        ->and($content->gatherMiddleware())->not->toContain('throttle:vaulter-public');
});

it('rate-limits the hub like the other public surface and names it for the metrics', function (): void {
    expect(app(VaulterThrottledRouteMap::class)->routeFor('vaulter.v1.collaboration.hub.append'))->toBe('collab.append')
        ->and(app(VaulterThrottledRouteMap::class)->routeFor('vaulter.v1.collaboration.hub.authenticate'))->toBe('collab.authenticate')
        ->and(app(VaulterThrottledRouteMap::class)->routeFor('vaulter.v1.collaboration.hub.store'))->toBeNull()
        ->and(app(VaulterHttpOperationMap::class)->operationFor('vaulter.v1.collaboration.hub.append'))->toBe('collab_append');
});

it('requires signed ownership calls and fences legacy append on a strict generation', function (): void {
    $node = Hub::document();
    config()->set('vaulter-collaboration.strict_profile', true);
    app(VaulterDatabase::class)->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $room = Hub::room($node);
    $token = Hub::token($node);
    Hub::call('authenticate', ['room' => $room, 'strict_capable' => true], $token)->assertOk()->assertJsonPath('profile', 'strict');
    Hub::call('authenticate', ['room' => $room], $token)->assertConflict()->assertJsonPath('meta.context.reason', 'strict_hub_required');

    $address = ['document_id' => (string) Hub::aggregate($node)->getKey(), 'generation' => 0, 'owner_id' => (string) Str::uuid()];
    $this->postJson(Docs::url('collaboration/hub/ownership/acquire'), $address, [
        'Content-Length' => (string) strlen(json_encode($address, JSON_THROW_ON_ERROR)),
    ])->assertUnauthorized();
    Hub::callV2('ownership/acquire', $address + ['include_log' => true], null)
        ->assertOk()->assertJsonPath('owner_fence', 1)->assertJsonPath('log.head_seq', 0);
    Hub::callV2('commands/next', $address + ['owner_fence' => 1], null)
        ->assertOk()->assertJsonPath('command', null);
    Hub::callV2('ownership/renew', $address + ['owner_fence' => 2], null)
        ->assertConflict()->assertJsonPath('meta.context.reason', 'stale_owner');

    $seed = Hub::seedBody($node, 'seed');
    Hub::call('append', $seed, $token)->assertConflict()->assertJsonPath('meta.context.reason', 'strict_profile_required');
    Hub::call('append', $seed + ['owner_id' => $address['owner_id'], 'owner_fence' => 1, 'base_seq' => 0], $token)
        ->assertOk()->assertJsonPath('seq', 1);
});

it('validates the owner fence, base position and browser binding of a fenced append before it reaches the journal', function (): void {
    $node = Hub::document();
    config()->set('vaulter-collaboration.strict_profile', true);
    app(VaulterDatabase::class)->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $token = Hub::token($node);
    Hub::call('authenticate', ['room' => Hub::room($node), 'strict_capable' => true], $token)->assertOk()->assertJsonPath('profile', 'strict');
    $address = ['document_id' => (string) Hub::aggregate($node)->getKey(), 'generation' => 0, 'owner_id' => (string) Str::uuid()];
    Hub::callV2('ownership/acquire', $address + ['include_log' => true], null)->assertOk()->assertJsonPath('owner_fence', 1);
    $fenced = Hub::seedBody($node, 'seed') + ['owner_id' => $address['owner_id'], 'owner_fence' => 1, 'base_seq' => 0];

    foreach ([
        'fence zero' => ['owner_fence' => 0],
        'negative base' => ['base_seq' => -1],
        'string receipt_only' => ['receipt_only' => 'yes'],
        'session that is no uuid' => ['client_session_id' => 'session-1'],
        'bound client id below the browser range' => ['bound_client_id' => 5],
        'bound client id above 32 bits' => ['bound_client_id' => 0x100000000],
    ] as $label => $override) {
        expect(Hub::call('append', [...$fenced, ...$override], $token)->status())->toBe(422, $label);
    }
    Hub::call('append', $fenced, $token)->assertOk()->assertJsonPath('seq', 1);
});

it('refuses a body signature whose timestamp header is not a plain decimal', function (): void {
    $node = Hub::document();
    $token = Hub::token($node);
    $body = ['room' => Hub::room($node), 'nonce' => bin2hex(random_bytes(8))];
    $headers = Hub::headers($body, $token) + [HubProtocol::HEADER => '2'];
    $timestamp = $headers[CollaborationCallResolver::TIMESTAMP_HEADER];

    // The signature is valid for the integer the header starts with; the header itself must be that integer.
    foreach ([$timestamp.'x', '+'.$timestamp, $timestamp.'.0'] as $presented) {
        test()->postJson('api/vaulter/v1/collaboration/hub/authenticate', $body, [...$headers, CollaborationCallResolver::TIMESTAMP_HEADER => $presented])
            ->assertUnauthorized();
    }
    test()->postJson('api/vaulter/v1/collaboration/hub/authenticate', $body, $headers)->assertOk();
});

it('propagates incoming traceparent headers on hub/append and commands/settle into tracing context', function (): void {
    $node = Hub::document();
    config()->set('vaulter-collaboration.strict_profile', true);
    app(VaulterDatabase::class)->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $token = Hub::token($node);
    $traceId = '0123456789abcdef0123456789abcdef';
    $spanId = '89abcdef01234567';
    $traceparent = '00-'.$traceId.'-'.$spanId.'-01';

    $capturedPayloads = [];
    $recorder = new OtlpOpenTelemetryTraceRecorder(
        serviceName: 'vaulter-collab-test',
        transport: static function (string $endpoint, string $payload) use (&$capturedPayloads): void {
            $capturedPayloads[] = $payload;
        },
    );
    config()->set('vaulter.observability.tracing.enabled', true);
    config()->set('vaulter.observability.tracing.recorder', OtlpOpenTelemetryTraceRecorder::class);
    app()->instance(OtlpOpenTelemetryTraceRecorder::class, $recorder);
    app()->forgetInstance(TraceRecorder::class);

    $session = (string) Str::uuid();
    $auth = Hub::call('authenticate', ['room' => Hub::room($node), 'strict_capable' => true, 'bind_session' => $session], $token)->assertOk();
    $boundClientId = (int) $auth->json('bound_client_id');
    $address = ['document_id' => (string) Hub::aggregate($node)->getKey(), 'generation' => 0, 'owner_id' => (string) Str::uuid()];
    Hub::callV2('ownership/acquire', $address + ['include_log' => true], null)->assertOk();

    $seedBody = Hub::seedBody($node, 'traced-seed');
    $settleBody = $address + [
        'owner_fence' => 1,
        'kind' => 'seed',
        'base_seq' => 0,
        'seed_state_version' => 1,
        'update' => [
            'update_id' => $seedBody['update_id'],
            'sha256' => $seedBody['sha256'],
            'payload' => $seedBody['payload'],
        ],
    ];
    $settleHeaders = Hub::headers($settleBody, null) + [HubProtocol::HEADER => '2', 'traceparent' => $traceparent];
    test()->postJson('api/vaulter/v1/collaboration/hub/commands/settle', $settleBody, $settleHeaders)
        ->assertOk()
        ->assertJsonPath('seq', 1);

    $appendBody = Hub::appendBody($node, 'traced-edit') + [
        'owner_id' => $address['owner_id'],
        'owner_fence' => 1,
        'base_seq' => 1,
        'bound_client_id' => $boundClientId,
        'client_session_id' => $session,
    ];
    $appendHeaders = Hub::headers($appendBody, $token) + [HubProtocol::HEADER => '2', 'traceparent' => $traceparent];
    test()->postJson('api/vaulter/v1/collaboration/hub/append', $appendBody, $appendHeaders)
        ->assertOk()
        ->assertJsonPath('seq', 2);

    $recorder->flush();
    $combinedPayloads = implode('', $capturedPayloads);
    expect($recorder->bufferedCount())->toBe(0)
        ->and($capturedPayloads)->not->toBeEmpty()
        ->and($combinedPayloads)->toContain((string) hex2bin($traceId))
        ->and($combinedPayloads)->toContain('vaulter.collaboration.hub')
        ->and($combinedPayloads)->toContain('collaboration.hub.commands.settle')
        ->and($combinedPayloads)->toContain('collaboration.hub.append')
        ->and(collect($capturedPayloads)->filter(static fn (string $payload): bool => str_contains($payload, 'collaboration.hub.commands.settle') && str_contains($payload, (string) hex2bin($traceId))))->not->toBeEmpty()
        ->and(collect($capturedPayloads)->filter(static fn (string $payload): bool => str_contains($payload, 'collaboration.hub.append') && str_contains($payload, (string) hex2bin($traceId))))->not->toBeEmpty();
});

it('never exports raw exception messages from TraceCollaborationCall spans', function (): void {
    $capturedPayloads = [];
    $recorder = new OtlpOpenTelemetryTraceRecorder(
        serviceName: 'vaulter-collab-redact-test',
        transport: static function (string $endpoint, string $payload) use (&$capturedPayloads): void {
            $capturedPayloads[] = $payload;
        },
    );

    $middleware = new TraceCollaborationCall($recorder);
    $request = Request::create('/api/vaulter/v1/collaboration/hub/append', 'POST');
    $request->headers->set('traceparent', '00-0123456789abcdef0123456789abcdef-89abcdef01234567-01');
    $secretSql = 'SQLSTATE[23505] secret-binding-leak-xyz';

    expect(fn (): Response => $middleware->handle($request, static function () use ($secretSql): never {
        throw new RuntimeException($secretSql, 7);
    }))->toThrow(RuntimeException::class);

    $recorder->flush();
    expect($capturedPayloads)->toHaveCount(1)
        ->and($capturedPayloads[0])->not->toContain($secretSql)
        ->and($capturedPayloads[0])->not->toContain('secret-binding-leak-xyz')
        ->and($capturedPayloads[0])->toContain(RuntimeException::class);
});

it('returns each command traceparent (or null) on commands/next without cross-command leakage', function (): void {
    $node = Hub::document();
    config()->set('vaulter-collaboration.strict_profile', true);
    $db = app(VaulterDatabase::class);
    $db->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $token = Hub::token($node);
    Hub::call('authenticate', ['room' => Hub::room($node), 'strict_capable' => true, 'bind_session' => (string) Str::uuid()], $token)->assertOk();
    $owner = (string) Str::uuid();
    $address = ['document_id' => (string) Hub::aggregate($node)->getKey(), 'generation' => 0, 'owner_id' => $owner];
    Hub::callV2('ownership/acquire', $address + ['include_log' => true], null)->assertOk();

    $journal = app(CommandJournal::class);
    $scope = new CommandActor(
        Actor::user(AccessTestHelpers::user())->ref(),
        null,
        'test',
        'writer',
        (string) $node->drive_id,
        (string) $node->getKey(),
    );
    $cmdTraceparent = '00-fedcba9876543210fedcba9876543210-1122334455667788-01';
    $traced = $journal->register($scope, 'http-traced', (string) Str::uuid(), hash('sha256', 'traced'), 0, 1, 0, ['atomic_effects' => []], $cmdTraceparent);
    $untraced = $journal->register($scope, 'http-untraced', (string) Str::uuid(), hash('sha256', 'untraced'), 0, 1, 0, ['atomic_effects' => []]);

    Hub::callV2('commands/next', $address + ['owner_fence' => 1], null)
        ->assertOk()
        ->assertJsonPath('command.id', $traced['id'])
        ->assertJsonPath('command.traceparent', $cmdTraceparent);

    $journal->settle($traced['id'], $owner, 1, 0, 0, $traced['fingerprint'], [], ['ranges' => []]);

    Hub::callV2('commands/next', $address + ['owner_fence' => 1], null)
        ->assertOk()
        ->assertJsonPath('command.id', $untraced['id'])
        ->assertJsonPath('command.traceparent', null);
});
