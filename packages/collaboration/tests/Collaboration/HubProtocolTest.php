<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\Exceptions\CollaborationSeedConflictException;
use Vaulter\Collaboration\Persistence\CheckpointResult;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Actions\Revisions\RestoreDocumentRevisionAction;
use Vaulter\Documents\Data\Revisions\RestoreDocumentRevisionInput;
use Vaulter\Documents\Events\Revisions\DocumentRestored;
use Vaulter\Documents\Exceptions\CollaborationUnavailableException;
use Vaulter\Documents\Exceptions\DocumentStateTooLargeException;
use Vaulter\Documents\Exceptions\InvalidDocumentContentException;
use Vaulter\Documents\Facades\Documents;
use Vaulter\Documents\Models\Revisions\DocumentRevision;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;

/**
 * The hub protocol 2 end to end at the HTTP boundary: load → seed → append behind the
 * epoch fence, read-only enforced by the backend, and every call re-checking the live
 * document (trash, drive status, tenant, rights). The hub process itself is covered by
 * packages/collaboration/hub/test.
 */
beforeEach(function (): void {
    Hub::configure();
    // A checkpoint is published under a lease, and a single record is due for one here.
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
});

function hubRestore(Node $node, DocumentRevision $revision): DocumentRevision
{
    return app(RestoreDocumentRevisionAction::class)->execute(
        DocumentTestHelpers::context($node, actorId: 1),
        new RestoreDocumentRevisionInput(node: $node, revision: $revision),
    );
}

// ── load and seed ───────────────────────────────────────────────────────────────────

it('loads the JSON to seed from while the document has no Yjs state, then the state', function (): void {
    $node = Hub::document();

    Hub::call('load', ['room' => Hub::room($node)], Hub::token($node))
        ->assertOk()
        ->assertHeader('X-Vaulter-Collab-Protocol', '2')
        ->assertJsonPath('checkpoint', null)
        ->assertJsonPath('tail', [])
        ->assertJsonPath('content.content.0.content.0.text', 'Draft')
        ->assertJsonPath('generation', 0)
        ->assertJsonPath('schema_version', 1)
        ->assertJsonPath('state_version', 1)
        ->assertJsonPath('type', 'vaulter/rich-text');

    $seed = Hub::seedBody($node, 'seeded-state', stateVersion: 1);
    Hub::call('append', $seed, Hub::token($node))->assertOk()->assertJsonPath('seq', 1);

    // The seed is the log's first record: every hub replays it instead of seeding again.
    Hub::call('load', ['room' => Hub::room($node)], Hub::token($node))
        ->assertOk()
        ->assertJsonPath('checkpoint', null)
        ->assertJsonPath('head_seq', 1)
        ->assertJsonPath('tail', [['seq' => 1, 'update_id' => $seed['update_id'], 'payload' => base64_encode('seeded-state')]])
        ->assertJsonPath('state_version', 1);
});

it('lets a read-only connection load but never append', function (): void {
    $node = Hub::document(level: RoleRegistry::READER);

    Hub::call('load', ['room' => Hub::room($node)], Hub::token($node, mode: 'ro'))->assertOk();
    // Even a token that claims rw writes nothing for a user who now only reads.
    Hub::call('append', Hub::appendBody($node, 'reader-edit'), Hub::token($node, mode: 'rw'))->assertForbidden();
    Hub::call('append', Hub::seedBody($node, 'reader-seed'), Hub::token($node, mode: 'ro'))->assertForbidden();

    expect(Compaction::head($node))->toBeNull()
        ->and(Hub::aggregate($node)->pending_through_seq)->toBeNull();
});

it('accepts exactly one seed per generation', function (): void {
    $node = Hub::document();
    $first = Hub::seedBody($node, 'first-seed');

    Hub::call('append', $first, Hub::token($node))->assertOk()->assertJsonPath('seq', 1);
    Hub::call('append', Hub::seedBody($node, 'second-seed', stateVersion: 1), Hub::token($node))
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_seed_conflict');
    // The first seed's retry is answered from its receipt, not refused as a second seed.
    Hub::call('append', $first, Hub::token($node))->assertOk()->assertJsonPath('seq', 1);

    expect(Compaction::seqs($node))->toBe([1]);
});

it('refuses a seed over a generation that starts from a checkpoint', function (): void {
    $node = Hub::document();
    Hub::call('append', Hub::seedBody($node, 'seed'), Hub::token($node))->assertOk();
    Compaction::publish(Compaction::leaseOf($node));
    $version = Hub::aggregate($node)->state_version;

    expect(Compaction::seqs($node))->toBe([]);
    Hub::call('append', Hub::seedBody($node, 'late-seed', stateVersion: $version), Hub::token($node))
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_seed_conflict');
});

it('publishes the projection the hub emits for a link, an image and a table in a checkpoint', function (): void {
    // Exactly what the hub projects (TiptapTransformer.fromYdoc): the link mark
    // carries every attribute @tiptap/extension-link declares, `title: null` included.
    $projection = ['type' => 'doc', 'content' => [
        ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'see', 'marks' => [['type' => 'link', 'attrs' => [
            'href' => 'https://example.com', 'target' => '_blank', 'rel' => 'noopener noreferrer nofollow', 'class' => null, 'title' => null,
        ]]]]]],
        ['type' => 'image', 'attrs' => ['src' => 'https://example.com/a.png', 'alt' => 'a']],
        ['type' => 'table', 'content' => [['type' => 'tableRow', 'content' => [
            ['type' => 'tableHeader', 'attrs' => ['colspan' => 1, 'rowspan' => 1], 'content' => [['type' => 'paragraph']]],
            ['type' => 'tableCell', 'attrs' => ['colspan' => 1, 'rowspan' => 1], 'content' => [['type' => 'paragraph']]],
        ]]]],
    ]];
    $node = Hub::document();

    Hub::call('append', Hub::seedBody($node, 'seed-with-link'), Hub::token($node))->assertOk();
    Hub::call('append', Hub::appendBody($node, 'edit-with-link'), Hub::token($node))->assertOk();
    $result = Compaction::publish(Compaction::leaseOf($node), overrides: ['content' => $projection]);

    expect($result->markerCleared)->toBeTrue()
        ->and(Hub::aggregate($node)->content['content'][0]['content'][0]['marks'][0]['attrs']['href'])->toBe('https://example.com');
});

it('refuses a seed built before a REST update and loses no text', function (): void {
    $node = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
    $loaded = Hub::call('load', ['room' => Hub::room($node)], Hub::token($node))->assertOk();
    $version = $loaded->json('state_version');

    // A REST replace of a collaborative document without a checkpoint is an explicit reseed: the generation moves once.
    $handle = Vaulter::drive($node->storage()->firstOrFail())->actingAs(AccessTestHelpers::user(1));
    Documents::in($handle)->update($node->id, Hub::tiptap('Written over REST'));
    expect(Hub::aggregate($node)->collab_epoch)->toBe(1);

    // The hub still seeds from what it loaded ('Draft'): refused, 'Written over REST' survives.
    Hub::call('append', Hub::seedBody($node, 'stale-seed', stateVersion: $version), Hub::token($node))
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_seed_conflict')
        ->assertJsonPath('meta.context.expected_state_version', $version)
        ->assertJsonPath('meta.context.actual_state_version', Hub::aggregate($node)->state_version);
    $after = Hub::aggregate($node);
    expect($after->collab_state)->toBeNull()
        ->and($after->pending_through_seq)->toBeNull()
        ->and(Compaction::seqs($node))->toBe([])
        ->and($after->content['content'][0]['content'][0]['text'])->toBe('Written over REST');

    // The hub loads again and seeds from the current content.
    $reloaded = Hub::call('load', ['room' => Hub::room($node)], Hub::token($node))
        ->assertOk()
        ->assertJsonPath('content.content.0.content.0.text', 'Written over REST');
    Hub::call('append', Hub::seedBody($node, 'fresh-seed', stateVersion: $reloaded->json('state_version')), Hub::token($node))
        ->assertOk()
        ->assertJsonPath('seq', 1);
});

it('rejects a malformed seed state_version', function (): void {
    $node = Hub::document();

    foreach (['3', -1, 1.5, true] as $bad) {
        Hub::call('append', [...Hub::appendBody($node, 'seed', origin: 'server'), 'seed_state_version' => $bad], Hub::token($node))
            ->assertStatus(422)
            ->assertJsonValidationErrors('seed_state_version');
    }

    expect(Compaction::head($node))->toBeNull();
});

// ── the epoch fence ─────────────────────────────────────────────────────────────────

it('fences off an append from the room opened before a restore (V12)', function (): void {
    Event::fake([DocumentRestored::class]);
    $node = Hub::document();
    $first = DocumentTestHelpers::head($node);
    $oldToken = Hub::token($node);

    hubRestore($node, $first);

    $restored = Hub::aggregate($node);
    expect($restored->collab_epoch)->toBe(1)
        ->and($restored->content['content'][0]['content'][0]['text'])->toBe('Draft');
    Event::assertDispatched(DocumentRestored::class, static fn (DocumentRestored $event): bool => $event->epoch === 1
        && $event->restoredFrom->id === (string) $first->getKey()
        && $event->stateVersion === $restored->state_version);

    // The old room's pending update arrives late: refused, nothing changes.
    Hub::call('append', Hub::appendBody($node, 'late-old-edit', generation: 0), $oldToken)
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_epoch_mismatch')
        ->assertJsonPath('meta.context.expected', 0)
        ->assertJsonPath('meta.context.actual', 1);
    // The old room can neither reconnect nor load.
    foreach (['authenticate', 'load'] as $endpoint) {
        Hub::call($endpoint, ['room' => Hub::room($node, 0)], $oldToken)
            ->assertStatus(409)
            ->assertJsonPath('code', 'collaboration_epoch_mismatch');
    }

    $after = Hub::aggregate($node);
    expect($after->content)->toBe($restored->content)
        ->and($after->collab_state)->toBe($restored->collab_state)
        ->and($after->state_version)->toBe($restored->state_version)
        ->and(Compaction::head($node, 0))->toBeNull();

    // The new generation loads the restored content and writes again.
    Hub::call('load', ['room' => Hub::room($node)], Hub::token($node))
        ->assertOk()
        ->assertJsonPath('generation', 1);
    Hub::call('append', Hub::seedBody($node, 'new-room-seed'), Hub::token($node))->assertOk()->assertJsonPath('generation', 1);
});

it('fences a past epoch inside the locked write itself, not only at the endpoint', function (): void {
    $node = Hub::document();
    hubRestore($node, DocumentTestHelpers::head($node));
    $before = Hub::aggregate($node);

    expect(fn () => app(UpdateLog::class)->append($node->getKey(), new UpdateEnvelope(
        generation: 0, updateId: (string) Str::uuid(), payload: 'stale-room', claimedSha256: hash('sha256', 'stale-room'),
    )))->toThrow(CollaborationEpochMismatchException::class);

    expect(Hub::aggregate($node)->state_version)->toBe($before->state_version)
        ->and(Compaction::head($node, 0))->toBeNull();
});

it('moves the epoch on an external JSON replace of a document with Yjs state', function (): void {
    $node = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
    Hub::call('append', Hub::seedBody($node, 'room-state'), Hub::token($node))->assertOk();
    Compaction::publish(Compaction::leaseOf($node));

    $handle = Vaulter::drive($node->storage()->firstOrFail())->actingAs(AccessTestHelpers::user(1));
    Documents::in($handle)->update($node->id, Hub::tiptap('Replaced by API'));

    $document = Hub::aggregate($node);
    expect($document->collab_epoch)->toBe(1)
        // The hub seeds the next room from the replaced JSON.
        ->and($document->collab_state)->toBeNull();
    Hub::call('append', Hub::appendBody($node, 'stale', generation: 0), Hub::token($node, epoch: 0))
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_epoch_mismatch');
});

// ── live checks on every call ───────────────────────────────────────────────────────

it('takes a revoked Edit into account on the next call (OPUS D24)', function (): void {
    $node = Hub::document(level: RoleRegistry::WRITER);
    $token = Hub::token($node);
    Hub::call('authenticate', ['room' => Hub::room($node)], $token)->assertJsonPath('mode', 'rw');

    $grants = config('vaulter-drive.models.grant');
    app(VaulterDatabase::class)->write(fn () => $grants::query()->where('node_id', $node->id)->delete());
    AccessTestHelpers::grant($node, RoleRegistry::READER, subjectId: 1);

    Hub::call('authenticate', ['room' => Hub::room($node)], $token)->assertOk()->assertJsonPath('mode', 'ro');
    Hub::call('append', Hub::appendBody($node, 'after-revoke'), $token)->assertForbidden();
});

it('shares an archived drive read-only', function (): void {
    $node = Hub::document();
    app(VaulterDatabase::class)->write(fn () => $node->storage()->update(['status' => 'archived']));

    Hub::call('authenticate', ['room' => Hub::room($node)], Hub::token($node))
        ->assertOk()
        ->assertJsonPath('allowed', true)
        ->assertJsonPath('mode', 'ro');
    Hub::call('load', ['room' => Hub::room($node)], Hub::token($node))->assertOk();
    Hub::call('append', Hub::appendBody($node, 'archived-edit'), Hub::token($node))->assertForbidden();
});

it('answers node_not_found for a trashed document, another tenant or a drive being deleted', function (Closure $change): void {
    $node = Hub::document();
    $token = Hub::token($node);
    $change($node);

    foreach (['authenticate', 'load'] as $endpoint) {
        Hub::call($endpoint, ['room' => Hub::room($node, 0)], $token)
            ->assertNotFound()
            ->assertJsonPath('code', 'node_not_found');
    }
    Hub::call('append', Hub::appendBody($node, 'gone', generation: 0), $token)->assertNotFound();
})->with([
    'trashed' => [static fn (Node $node) => Vaulter::drive($node->storage()->firstOrFail())->asSystem('hub test')->nodes()->trash($node->id)],
    'drive deleting' => [static fn (Node $node) => app(VaulterDatabase::class)->write(fn () => $node->storage()->update(['status' => 'deleting']))],
    'token of another tenant' => [static fn (Node $node) => app(VaulterDatabase::class)->write(fn () => Node::query()->whereKey($node->id)->update(['tenant_id' => 'tenant-b']))],
]);

it('refuses a body that names another room than the token', function (): void {
    $node = Hub::document();

    Hub::call('authenticate', ['room' => Hub::room($node).'0'], Hub::token($node))->assertForbidden();
    Hub::call('load', [], Hub::token($node))->assertForbidden();
    Hub::call('append', ['room' => Hub::room($node).'0'] + Hub::appendBody($node, 'x'), Hub::token($node))->assertForbidden();
});

// ── limits ──────────────────────────────────────────────────────────────────────────

it('refuses a checkpoint state above collaboration.max_state_bytes with 413 and writes nothing', function (): void {
    config()->set('vaulter-collaboration.max_state_bytes', 8);
    $node = Hub::document();
    Hub::call('append', Hub::seedBody($node, 'seed'), Hub::token($node))->assertOk();
    $lease = Compaction::leaseOf($node);
    $checkpoint = static fn (string $state): array => [
        'document' => $lease->nodeId,
        'generation' => 0,
        'lease_token' => $lease->token,
        'covered_from' => 0,
        'covered_through' => 1,
        'expected_checkpoint_version' => $lease->checkpointVersion,
        'state' => base64_encode($state),
        'content' => Hub::tiptap('Seed'),
        'protocol' => $lease->log->binding->protocol,
        'state_format' => $lease->log->binding->stateFormat,
        'schema_version' => $lease->log->binding->schemaVersion,
        'type' => $lease->log->type,
    ];

    Hub::callV2('checkpoint', $checkpoint(str_repeat('y', 9)), token: null)
        ->assertStatus(413)
        ->assertJsonPath('code', 'collaboration_update_too_large');
    expect(Hub::aggregate($node)->collab_state)->toBeNull()
        ->and(Compaction::seqs($node))->toBe([1]);

    Hub::callV2('checkpoint', $checkpoint(str_repeat('y', 8)), token: null)->assertOk()->assertJsonPath('marker_cleared', true);
});

it('refuses a checkpoint projection above the content limit', function (): void {
    config()->set('vaulter-documents.content.max_size_kb', 1);
    $node = Hub::document();
    Hub::call('append', Hub::seedBody($node, 'seed'), Hub::token($node))->assertOk();

    expect(fn (): CheckpointResult => Compaction::publish(Compaction::leaseOf($node), overrides: ['content' => Hub::tiptap(str_repeat('x', 2048))]))
        ->toThrow(InvalidDocumentContentException::class);
    expect(Hub::aggregate($node)->collab_state)->toBeNull()
        ->and(Compaction::marker($node))->toBe([0, 1]);
});

// ── error contract ──────────────────────────────────────────────────────────────────

it('keeps the stable codes and statuses of the collaboration errors', function (Throwable $exception, string $code, int $status): void {
    expect($exception->problemCode())->toBe($code)
        ->and($exception->httpStatus())->toBe($status);
})->with([
    'epoch mismatch' => [new CollaborationEpochMismatchException(1, 2), 'collaboration_epoch_mismatch', 409],
    'seed conflict' => [new CollaborationSeedConflictException('42'), 'collaboration_seed_conflict', 409],
    'unavailable' => [CollaborationUnavailableException::unsupportedType('vaulter/spreadsheet'), 'collaboration_unavailable', 409],
    'state too large' => [new DocumentStateTooLargeException(10, 8), 'document_state_too_large', 413],
]);
