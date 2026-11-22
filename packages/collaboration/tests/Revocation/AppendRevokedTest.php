<?php

declare(strict_types=1);

use Illuminate\Support\Str;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\CollaborationHub;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\Revocation;
use Vaulter\Drive\Access\AccessInvalidation;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Drive\Models\Access\NodeGrant;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;

/**
 * A revoked writer's append: the append re-checks the subject's rights every time, so whatever revoked
 * them — the grant on an ancestor, a move, a cut of inheritance, an archive, a host change the drive never saw — the
 * next append is refused, with or without a control message. A token older than its drive's permission version is
 * only a hint: the append still answers by the rights now and tells the hub the token is stale.
 */
beforeEach(function (): void {
    Hub::configure();
    ['drive' => $this->drive, 'folder' => $this->folder, 'grant' => $this->grant, 'node' => $this->node] = Revocation::inheritedDocument();
    $this->token = Hub::token($this->node);
});

it('appends for a writer whose rights hold, with a current token that is not stale', function (): void {
    Hub::call('append', Hub::seedBody($this->node, 'u1'), $this->token)
        ->assertOk()->assertJsonPath('persisted', true)->assertJsonPath('permissions_stale', false);

    expect(Compaction::seqs($this->node))->toBe([1]);
});

it('refuses the append of a writer whose inherited Edit was revoked while View stayed: 403', function (): void {
    AccessTestHelpers::grant($this->node, RoleRegistry::READER);
    $this->drive->access()->revoke($this->folder->id, $this->grant);

    Hub::call('append', Hub::seedBody($this->node, 'u1'), $this->token)
        ->assertForbidden()->assertJsonPath('code', 'permission_denied');

    expect(Compaction::seqs($this->node))->toBe([]);
});

it('answers a writer who lost every right as if the document did not exist: 404', function (): void {
    $this->drive->access()->revoke($this->folder->id, $this->grant);

    Hub::call('append', Hub::seedBody($this->node, 'u1'), $this->token)
        ->assertNotFound()->assertJsonPath('code', 'node_not_found');

    expect(Compaction::seqs($this->node))->toBe([]);
});

it('refuses the append after the document moved into a subtree the writer has no rights in', function (): void {
    $elsewhere = $this->drive->folders()->create('Elsewhere');
    $this->drive->nodes()->move((string) $this->node->getKey(), $elsewhere->id);

    Hub::call('append', Hub::seedBody($this->node, 'u1'), $this->token)->assertNotFound();

    expect(Compaction::seqs($this->node))->toBe([]);
});

it('refuses the append after the document stopped inheriting the folder\'s grants', function (): void {
    $this->drive->access()->restrictInheritance((string) $this->node->getKey());

    Hub::call('append', Hub::seedBody($this->node, 'u1'), $this->token)->assertNotFound();
});

it('refuses the append once the drive is archived', function (): void {
    $this->drive->archive();

    Hub::call('append', Hub::seedBody($this->node, 'u1'), $this->token)->assertForbidden();
});

it('appends with a stale token while the rights hold, and tells the hub it is stale', function (): void {
    $this->drive->access()->grant($this->folder->id, new GrantInput(subject: Revocation::subject(7), role: RoleRegistry::READER));

    Hub::call('append', Hub::seedBody($this->node, 'u1'), $this->token)
        ->assertOk()->assertJsonPath('permissions_stale', true);
    Hub::call('append', Hub::appendBody($this->node, 'u2'), Hub::token($this->node))
        ->assertOk()->assertJsonPath('permissions_stale', false);

    expect(Compaction::seqs($this->node))->toBe([1, 2]);
});

it('marks every token stale after a global host change', function (): void {
    app(AccessInvalidation::class)->changed(null, 'host-role');

    Hub::call('append', Hub::seedBody($this->node, 'u1'), $this->token)
        ->assertOk()->assertJsonPath('permissions_stale', true);
});

it('checks the rights even when the versions say nothing changed', function (): void {
    // A host change the drive was never told about: no event, no version, the token looks current.
    NodeGrant::query()->whereKey($this->grant->id)->toBase()->delete();

    Hub::call('append', Hub::seedBody($this->node, 'u1'), Hub::token($this->node))->assertNotFound();

    expect(Compaction::seqs($this->node))->toBe([]);
});

it('rechecks live authority after the room was opened and preserves the ACKed log for service checkpoint', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    Hub::call('append', Hub::seedBody($this->node, 'accepted'), $this->token)->assertOk()->assertJsonPath('persisted', true);
    $call = app(CollaborationCallResolver::class)->verifyToken($this->token);
    $hub = app(CollaborationHub::class);
    $room = $hub->open($call, $call->room);
    $lease = Compaction::leaseOf($this->node);
    $this->drive->access()->revoke($this->folder->id, $this->grant);
    $update = new UpdateEnvelope(0, (string) Str::uuid(), 'denied', hash('sha256', 'denied'), 'client');
    expect(fn () => $hub->append($room, $call, $update))->toThrow(NodeNotFoundException::class);
    expect(Compaction::seqs($this->node))->toBe([1]);
    Hub::call('checkpoint', [
        'document' => $lease->nodeId, 'generation' => 0, 'lease_token' => $lease->token,
        'covered_from' => 0, 'covered_through' => 1, 'expected_checkpoint_version' => $lease->checkpointVersion,
        'protocol' => 'yjs', 'state_format' => 'yjs-update-v1', 'schema_version' => 1, 'type' => 'vaulter/rich-text',
        'state' => base64_encode('accepted'), 'content' => Hub::tiptap('Accepted before revoke'),
    ], null)->assertOk()->assertJsonPath('marker_cleared', true);
    expect(Hub::aggregate($this->node)->collab_state)->toBe('accepted')
        ->and(Compaction::seqs($this->node))->toBe([])
        ->and(Compaction::marker($this->node))->toBe([null, null]);
});
