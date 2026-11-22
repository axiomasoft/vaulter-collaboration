<?php

declare(strict_types=1);

use Illuminate\Routing\Route;
use Illuminate\Support\Facades\Route as Router;
use Vaulter\Collaboration\Http\Middleware\ResolveCollaborationCall;
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
