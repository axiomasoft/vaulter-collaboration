<?php

declare(strict_types=1);

use Firebase\JWT\JWT;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Laravel\Sanctum\SanctumServiceProvider;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Testing\Fixtures\FakeHostUserResolver;
use Vaulter\Collaboration\Tests\Collaboration\CollaborationEnabledTestCase;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Documents\Actions\Documents\CreateDocumentAction;
use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Testing\Fixtures\TestUser;

class HubMiddlewareStackTestCase extends CollaborationEnabledTestCase
{
    protected function getPackageProviders($app): array
    {
        return [...parent::getPackageProviders($app), SanctumServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $app['config']->set('vaulter.routes.middleware.authenticated', ['api', 'auth:sanctum']);
        $app['config']->set('vaulter-collaboration.hub.webhook_secret', 'middleware-stack-webhook-secret');
        $app['config']->set('vaulter-collaboration.hub.jwt_keys', ['k1' => 'middleware-stack-jwt-secret-at-least-32-bytes']);
        $app['config']->set('vaulter-collaboration.hub.jwt_active_kid', 'k1');
        $app['config']->set('vaulter-collaboration.hub.issuer', 'https://vaulter.test');
    }
}

uses(HubMiddlewareStackTestCase::class, RefreshDatabase::class);

/** @param array<string, mixed> $body */
function signedHubCall(array $body, string $jwt, int $timestamp): TestResponse
{
    return test()->postJson('api/vaulter/v1/collaboration/hub/authenticate', $body, [
        'Authorization' => 'Bearer '.$jwt,
        CollaborationCallResolver::TIMESTAMP_HEADER => (string) $timestamp,
        CollaborationCallResolver::SIGNATURE_HEADER => CollaborationCallResolver::signature((string) json_encode($body), 'middleware-stack-webhook-secret', $timestamp),
        HubProtocol::HEADER => (string) HubProtocol::VERSION,
    ]);
}

it('requires Sanctum on the session route and the hub credentials, not Sanctum, on the hub calls', function (): void {
    $this->postJson('api/vaulter/v1/documents/1/collaboration/session')->assertUnauthorized();
    // The hub stack is not the Sanctum one: a call without the room token and the body signature is refused by the hub resolver itself.
    $this->postJson('api/vaulter/v1/collaboration/hub/authenticate', ['room' => 'x'])->assertUnauthorized()->assertJsonPath('code', 'actor_required');
});

it('accepts a signed hub JWT without a Sanctum token', function (): void {
    $drive = DocumentTestHelpers::drive();
    app()->bind(HostUserResolver::class, fn (): FakeHostUserResolver => new FakeHostUserResolver(userType: (new TestUser)->getMorphClass()));
    $node = app(CreateDocumentAction::class)->execute(DocumentTestHelpers::context($drive->model()), new CreateDocumentInput(
        storage: $drive->model(), name: 'Hub', content: DocumentTestHelpers::content(), parent: DriveTestHelpers::model($drive->root()),
    ));
    $room = app(CollaborationOptions::class)->room($node->drive_id, $node->getKey(), 0);
    $body = ['room' => $room];
    $timestamp = time();
    $jwt = JWT::encode([
        'iss' => 'https://vaulter.test', 'aud' => 'vaulter-collaboration-hub', 'nbf' => $timestamp,
        'room' => $room, 'document_id' => (string) $node->getKey(), 'drive_id' => (string) $node->drive_id, 'tenant' => null,
        'generation' => 0, 'schema_version' => 1, 'scope' => 'write', 'permissions_version' => ['drive' => 0, 'global' => 0],
        'sub' => '17', 'sub_type' => (new TestUser)->getMorphClass(), 'protocol' => 'yjs/2', 'state_format' => 'yjs-update-v1', 'iat' => $timestamp, 'exp' => $timestamp + 300, 'jti' => 'middleware-stack',
    ], 'middleware-stack-jwt-secret-at-least-32-bytes', 'HS256', 'k1');

    signedHubCall($body, $jwt, $timestamp)->assertOk()->assertJsonPath('allowed', true)->assertJsonPath('userId', '17');
});
