<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Vaulter\Collaboration\Revocation\ControlConsumer;
use Vaulter\Collaboration\Revocation\SessionChecks;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\Revocation;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Drive\Access\AccessInvalidation;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Data\Sharing\ShareLinkInput;
use Vaulter\Drive\Models\Access\NodeGrant;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\Events\Outbox\OutboxStore;

/**
 * Effective permissions in a live session: what revokes a right is not always a grant on the
 * document — a grant on an ancestor, a share, a host role change. Each counts in the permission version of its drive (or
 * the global one) in its own transaction; a session issued before it is stale, the hub's recheck and renewal answer by
 * the rights now, and an append is refused at once even when no control message ever reaches the hub.
 */
beforeEach(function (): void {
    Hub::configure();
    config()->set('vaulter-drive.features.share_links', true);
    ['drive' => $this->drive, 'folder' => $this->folder, 'grant' => $this->grant, 'node' => $this->node] = Revocation::inheritedDocument();
});

/** @param list<array{id: string, token: string}> $connections */
function revocationRecheck(array $connections): TestResponse
{
    return Hub::call('recheck', ['connections' => $connections], null);
}

it('counts the revocation of a grant on an ancestor in the drive\'s version and refuses the old token\'s append', function (): void {
    // View stays through a direct grant on the document; Edit came from the folder only.
    AccessTestHelpers::grant($this->node, RoleRegistry::READER);
    $token = Hub::token($this->node);
    $before = Revocation::versions($this->node);

    $this->drive->access()->revoke($this->folder->id, $this->grant);

    expect(Revocation::versions($this->node)->drive)->toBe($before->drive + 1);
    Hub::call('append', Hub::seedBody($this->node, 'u1'), $token)->assertForbidden()->assertJsonPath('code', 'permission_denied');
    revocationRecheck([['id' => 'c1', 'token' => $token]])->assertOk()->assertJsonPath('results.0.access', 'read');
    expect(Compaction::seqs($this->node))->toBe([]);
});

it('counts the revocation of a share and makes the sessions of its drive stale', function (): void {
    $minted = $this->drive->shares()->create($this->folder->id, new ShareLinkInput);
    $token = Hub::token($this->node);
    $before = Revocation::versions($this->node);

    $this->drive->shares()->revoke($this->folder->id, $minted->link->id);

    expect(Revocation::versions($this->node)->drive)->toBe($before->drive + 1);
    // A share gives no right to the token's subject: the append is allowed, and stale.
    Hub::call('append', Hub::seedBody($this->node, 'u1'), $token)->assertOk()->assertJsonPath('permissions_stale', true);
});

it('counts a host role change globally, and the renewal checks the rights the host changed', function (): void {
    $token = Hub::token($this->node);
    $before = Revocation::globalVersion();
    // The host's permission driver stopped granting the role; the drive learns of it only through the invalidation.
    NodeGrant::query()->whereKey($this->grant->id)->toBase()->delete();

    app(AccessInvalidation::class)->changed(null, 'host-role');

    expect(Revocation::globalVersion())->toBe($before + 1);
    Hub::call('renew', ['room' => Hub::room($this->node)], $token)->assertNotFound();
    revocationRecheck([['id' => 'c1', 'token' => $token]])->assertOk()
        ->assertJsonPath('results.0.access', 'none')
        ->assertJsonPath('results.0.reason', 'gone');
});

it('refuses the revoked writer\'s append when the control message is lost (transport none)', function (): void {
    config()->set('vaulter-collaboration.control.transport', 'none');
    $token = Hub::token($this->node);

    $this->drive->access()->revoke($this->folder->id, $this->grant);
    Revocation::relayControl();

    expect(DB::table(app(DatabaseOptions::class)->table(OutboxStore::DELIVERIES))->where('consumer_id', ControlConsumer::ID)->where('state', 'done')->count())->toBeGreaterThan(0);
    Hub::call('append', Hub::seedBody($this->node, 'u1'), $token)->assertNotFound();
    expect(Compaction::seqs($this->node))->toBe([]);
});

it('answers a batch recheck connection by connection, in order', function (): void {
    ['node' => $readable] = Revocation::inheritedDocument(RoleRegistry::READER);
    ['drive' => $lostDrive, 'folder' => $lostFolder, 'grant' => $lostGrant, 'node' => $lost] = Revocation::inheritedDocument();
    $lostToken = Hub::token($lost);
    $lostDrive->access()->revoke($lostFolder->id, $lostGrant);
    $moved = Hub::token($this->node);
    DB::table(app(DatabaseOptions::class)->table('documents'))->where('node_id', $this->node->getKey())->increment('collab_epoch');

    $response = revocationRecheck([
        ['id' => 'reader', 'token' => Hub::token($readable)],
        ['id' => 'lost', 'token' => $lostToken],
        ['id' => 'expired', 'token' => Hub::token($readable, claims: ['exp' => time() - 120])],
        ['id' => 'tampered', 'token' => Hub::token($readable).'x'],
        ['id' => 'past-generation', 'token' => $moved],
    ])->assertOk();

    expect(array_map(static fn (array $result): array => [$result['id'], $result['access'], $result['reason']], $response->json('results')))->toBe([
        ['reader', 'read', null],
        ['lost', 'none', 'gone'],
        ['expired', 'none', 'token'],
        ['tampered', 'none', 'token'],
        ['past-generation', 'none', 'generation'],
    ])->and($response->json('results.1.jti'))->toBe(Revocation::claims($lostToken)['jti']);
});

it('keeps a writer writing on recheck while the rights hold', function (): void {
    revocationRecheck([['id' => 'w', 'token' => Hub::token($this->node)]])->assertOk()->assertJsonPath('results.0.access', 'write');
});

it('refuses an unsigned or malformed recheck', function (): void {
    $this->postJson('api/vaulter/v1/collaboration/hub/recheck', ['connections' => []], ['X-Vaulter-Collab-Protocol' => '2'])->assertUnauthorized();
    revocationRecheck([])->assertUnprocessable();
    revocationRecheck([['id' => '', 'token' => 'x']])->assertUnprocessable();
    revocationRecheck(array_fill(0, SessionChecks::MAX_RECHECK + 1, ['id' => 'c', 'token' => 'x']))->assertUnprocessable();
});

it('leaves the sessions of other drives current', function (): void {
    ['drive' => $other] = Revocation::inheritedDocument();
    $token = Hub::token($this->node);

    $other->archive();

    Hub::call('append', Hub::seedBody($this->node, 'u1'), $token)->assertOk()->assertJsonPath('permissions_stale', false);
});
