<?php

declare(strict_types=1);

use Illuminate\Auth\EloquentUserProvider;
use Illuminate\Auth\SessionGuard;
use Illuminate\Contracts\Auth\Factory;
use Illuminate\Database\Eloquent\Relations\Relation;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\HostUserResolver;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Testing\Fixtures\TestUser;
use Vaulter\ValueObjects\Access\ActorRef;

beforeEach(fn () => Hub::configure());

it('never resolves a same-id principal of a different model on any user backend route', function (string $endpoint): void {
    $node = Hub::document();
    $token = Hub::token($node, claims: ['sub_type' => 'other-host-model']);
    $body = $endpoint === 'append' ? Hub::appendBody($node, 'must-not-append') : ['room' => Hub::room($node)];
    Hub::call($endpoint, $body, $token)->assertNotFound();
})->with(['authenticate', 'load', 'append', 'renew']);

it('requires complete well-typed claims and an exactly matching room in the production verifier', function (array $claims): void {
    $node = Hub::document();
    expect(app(CollaborationCallResolver::class)->verifyToken(Hub::token($node, claims: $claims)))->toBeNull();
})->with([
    [['sub_type' => null]], [['sub_type' => '']], [['sub_type' => []]], [['sub_type' => ActorRef::SYSTEM_TYPE]],
    [['sub' => '']], [['sub' => 42]], [['protocol' => '']], [['state_format' => null]], [['schema_version' => 0]],
    [['schema_version' => '1']], [['generation' => -1]], [['room' => 'vaulter.documents.99.42.0']],
    [['tenant' => 0]], [['scope' => 'owner']],
]);

it('fences changed binding and tenant identity before any user backend access', function (array $claims): void {
    $node = Hub::document();
    $token = Hub::token($node, claims: $claims);
    $response = Hub::call('load', ['room' => Hub::room($node)], $token);
    $status = array_key_exists('tenant', $claims) ? 404 : (array_key_exists('protocol', $claims) ? 401 : 409);
    $response->assertStatus($status)->assertJsonPath('code', match ($status) {
        401 => 'actor_required',
        404 => 'node_not_found',
        default => 'collaboration_unavailable',
    });
})->with([[['tenant' => '0']], [['tenant' => '']], [['schema_version' => 2]], [['state_format' => 'foreign']], [['protocol' => 'foreign']]]);

it('keeps invalid room references hidden even when the actor has no View', function (string $endpoint, string $case): void {
    $node = Hub::document(level: null);
    $claims = [];
    $room = Hub::room($node, 0);
    if ($case === 'tenant') {
        $claims['tenant'] = 'other-tenant';
    }
    if ($case === 'drive' || $case === 'missing') {
        $driveId = $case === 'drive' ? (string) Hub::document()->drive_id : (string) $node->drive_id;
        $nodeId = $case === 'missing' ? '999999' : (string) $node->getKey();
        $room = app(CollaborationOptions::class)->room($driveId, $nodeId, 0);
        $claims = ['drive_id' => $driveId, 'document_id' => $nodeId, 'room' => $room];
    }
    if ($case === 'trash') {
        Vaulter::drive($node->storage()->firstOrFail())->asSystem('test fixture')->nodes()->trash((string) $node->getKey());
    }
    if ($case === 'deleting') {
        app(VaulterDatabase::class)->write(fn () => $node->storage()->update(['status' => 'deleting']));
    }
    if ($case === 'folder') {
        $node = DriveTestHelpers::model(Vaulter::drive($node->storage()->firstOrFail())->asSystem('test fixture')->folders()->create('Folder'));
        $room = Hub::room($node, 0);
    }

    Hub::call($endpoint, ['room' => $room], Hub::token($node, epoch: 0, claims: $claims))
        ->assertNotFound()->assertJsonPath('code', 'node_not_found');
})->with(['authenticate', 'load'])->with(['drive', 'tenant', 'missing', 'trash', 'deleting', 'folder']);

it('accepts only the trusted provider morph type and the exact resolved id', function (): void {
    $old = Relation::morphMap();
    try {
        Relation::morphMap(['staff' => TestUser::class], false);
        $provider = Mockery::mock(EloquentUserProvider::class);
        $provider->shouldReceive('getModel')->andReturn(TestUser::class);
        $provider->shouldReceive('retrieveById')->with('42')->once()->andReturn(AccessTestHelpers::user(42));
        $provider->shouldReceive('retrieveById')->with('43')->once()->andReturn(AccessTestHelpers::user(42));
        $guard = Mockery::mock(SessionGuard::class);
        $guard->shouldReceive('getProvider')->andReturn($provider);
        $auth = Mockery::mock(Factory::class);
        $auth->shouldReceive('guard')->andReturn($guard);
        $resolver = new HostUserResolver($auth);
        expect($resolver->find(new ActorRef('customer', '42')))->toBeNull()
            ->and($resolver->find(new ActorRef('staff', '42')))->toBeInstanceOf(TestUser::class)
            ->and($resolver->find(new ActorRef('staff', '43')))->toBeNull();
    } finally {
        Relation::morphMap($old, false);
    }
});
