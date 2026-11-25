<?php

declare(strict_types=1);

use Illuminate\Routing\Route;
use Illuminate\Support\Facades\Route as Router;
use Illuminate\Support\Str;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Http\Middleware\ResolveCollaborationCall;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\Http\Middleware\VaulterHttpOperationMap;
use Vaulter\Http\Middleware\VaulterThrottledRouteMap;

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
