<?php

declare(strict_types=1);

use Illuminate\Testing\TestResponse;
use Vaulter\Collaboration\Http\Support\HubProtocol;
use Vaulter\Collaboration\Persistence\CheckpointResult;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\AcmeKanbanV2Type;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Collaboration\Tests\Support\Revocation;
use Vaulter\Documents\Content\OpaqueContent;
use Vaulter\Documents\Content\TipTap\TipTapContent;
use Vaulter\Documents\Content\TipTap\TipTapSchema;
use Vaulter\Documents\Exceptions\InvalidDocumentContentException;
use Vaulter\Documents\Types\MarkdownDocumentType;
use Vaulter\Documents\Types\RichTextDocumentType;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Models\Node;

/**
 * Серверные вызовы хаба Hocuspocus (протокол 2): authenticate / load / append. Пускают только с
 * room-JWT И валидной HMAC-подписью тела (оба барьера обязательны; shared-секрет
 * личностью больше не является). Yjs-бинарь — источник истины (round-trip bytea +
 * размер), TipTap — проекция checkpoint. Комната жёстко привязана к узлу и поколению.
 */
beforeEach(function (): void {
    Hub::configure();
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
});

/**
 * A signed append as the hub posts it, with the protocol header; `$headers` overrides the signed ones.
 *
 * @param array<string, mixed>  $body
 * @param array<string, string> $headers
 */
function webhookAppend(array $body, array $headers): TestResponse
{
    return test()->postJson('api/vaulter/v1/collaboration/hub/append', $body, [HubProtocol::HEADER => '2', ...$headers]);
}

// ── collab/append ─────────────────────────────────────────────────────────────────

it('appends a binary update losslessly and publishes its checkpoint with the projection (bytea round-trips, size set)', function (): void {
    $node = Hub::document();
    $yjs = "\x00\x01\x02\x03binary-yjs-update\xff\xfe";

    Hub::call('append', Hub::seedBody($node, $yjs), Hub::token($node))
        ->assertOk()
        ->assertJsonPath('seq', 1)
        ->assertJsonPath('generation', 0);
    Hub::call('load', ['room' => Hub::room($node)], Hub::token($node))->assertOk()->assertJsonPath('tail.0.payload', base64_encode($yjs));

    Compaction::publish(Compaction::leaseOf($node), overrides: ['content' => Hub::tiptap('From hub')]);
    $state = Hub::aggregate($node);

    expect($state->collab_state)->toBe($yjs)
        ->and($state->collab_state_size)->toBe(strlen($yjs))
        ->and($state->content['content'][0]['content'][0]['text'] ?? null)->toBe('From hub');
});

it('requires the JSON projection with a checkpoint', function (): void {
    $node = Hub::document();
    Hub::call('append', Hub::seedBody($node, 'state-without-projection'), Hub::token($node))->assertOk();
    $lease = Compaction::leaseOf($node);

    Hub::callV2('checkpoint', [
        'document' => $lease->nodeId, 'generation' => 0, 'lease_token' => $lease->token, 'covered_from' => 0, 'covered_through' => 1,
        'expected_checkpoint_version' => $lease->checkpointVersion, 'state' => base64_encode('state-without-projection'),
    ], token: null)->assertStatus(422)->assertJsonValidationErrors('content');

    expect(Hub::aggregate($node)->collab_state)->toBeNull();
});

it('rejects an append call without a token, even when signed', function (): void {
    $node = Hub::document();

    Hub::call('append', Hub::appendBody($node, 'bytes'), null)->assertStatus(401);

    expect(Compaction::head($node))->toBeNull();
});

it('no longer accepts the shared webhook secret as an identity', function (): void {
    $node = Hub::document();
    $body = Hub::appendBody($node, 'bytes');

    webhookAppend($body, [
        ...Hub::headers($body, null),
        'X-Vaulter-Collab-Secret' => Hub::WEBHOOK_SECRET,
    ])->assertStatus(401);
});

it('rejects an append driven by a read-only room token', function (): void {
    $node = Hub::document();

    Hub::call('append', Hub::appendBody($node, 'bytes'), Hub::token($node, mode: 'ro'))
        ->assertForbidden();

    expect(Compaction::head($node))->toBeNull();
});

it('forbids a token minted for node A from addressing node B', function (): void {
    $nodeA = Hub::document();
    $nodeB = Hub::document();

    Hub::call('append', Hub::appendBody($nodeB, 'cross-node'), Hub::token($nodeA))
        ->assertForbidden();

    expect(Compaction::head($nodeB))->toBeNull();
});

it('rejects a tampered token and a token whose claims disagree with its room', function (array $claims, string $suffix): void {
    $node = Hub::document();

    Hub::call('append', Hub::appendBody($node, 'bytes'), Hub::token($node, claims: $claims).$suffix)
        ->assertStatus(401);
})->with([
    'tampered signature' => [[], 'x'],
    'document claim of another node' => [['document_id' => '999999'], ''],
    'drive claim of another drive' => [['drive_id' => '999999'], ''],
    'generation claim off the room' => [['generation' => 7], ''],
    'unknown scope' => [['scope' => 'admin'], ''],
    'the 0.x mode claim instead of a scope' => [['scope' => null, 'mode' => 'rw'], ''],
    'no permission versions' => [['permissions_version' => null], ''],
    'a permission version that is not a pair of counters' => [['permissions_version' => ['drive' => -1, 'global' => 0]], ''],
    'no token id' => [['jti' => ''], ''],
    'pre-0.3 room without epoch' => [['room' => 'vaulter.documents.1'], ''],
    'expired beyond the clock skew' => [['exp' => time() - 60], ''],
]);

// ── HMAC body signature ─────────────────────────────────────────────────────────────

it('rejects a token without a body signature', function (): void {
    $node = Hub::document();

    webhookAppend(Hub::appendBody($node, 'bytes'), ['Authorization' => 'Bearer '.Hub::token($node)])
        ->assertStatus(401);

    expect(Compaction::head($node))->toBeNull();
});

it('rejects a signature whose timestamp is outside the ±300s window', function (): void {
    $node = Hub::document();
    $body = Hub::appendBody($node, 'bytes');

    webhookAppend($body, Hub::headers($body, Hub::token($node), timestamp: time() - 301))
        ->assertStatus(401);
});

it('rejects a replayed signature (same nonce twice)', function (): void {
    $node = Hub::document();
    $body = Hub::seedBody($node, 'replay-bytes');
    $headers = Hub::headers($body, Hub::token($node));

    webhookAppend($body, $headers)->assertOk();
    webhookAppend($body, $headers)->assertStatus(401);
});

it('keeps the nonce until the signature itself expires, not just tolerance seconds from receipt', function (): void {
    $node = Hub::document();
    $body = Hub::seedBody($node, 'late-replay-bytes');
    // Future-dated within tolerance: the signature stays valid for ~550s from now.
    $headers = Hub::headers($body, Hub::token($node), timestamp: time() + 250);

    webhookAppend($body, $headers)->assertOk();

    $this->travel(400)->seconds();

    webhookAppend($body, $headers)->assertStatus(401);
});

it('rejects a body other than the signed one, without burning the nonce of the genuine delivery', function (): void {
    $node = Hub::document();
    $signed = Hub::seedBody($node, 'original-bytes');
    $headers = Hub::headers($signed, Hub::token($node));
    $tampered = [...$signed, 'payload' => base64_encode('swapped-bytes'), 'sha256' => hash('sha256', 'swapped-bytes')];

    webhookAppend($tampered, $headers)->assertStatus(401);
    webhookAppend($signed, $headers)->assertOk();

    expect(Compaction::seqs($node))->toBe([1]);
    Hub::call('load', ['room' => Hub::room($node)], Hub::token($node))->assertJsonPath('tail.0.payload', base64_encode('original-bytes'));
});

// ── collab/authenticate ─────────────────────────────────────────────────────────────

it('authenticates a writer read-write and a commenter read-only', function (string $level, string $mode): void {
    $node = Hub::document(level: $level);

    Hub::call('authenticate', ['room' => Hub::room($node)], Hub::token($node))
        ->assertOk()
        ->assertJsonPath('allowed', true)
        ->assertJsonPath('mode', $mode)
        ->assertJsonPath('userId', '1')
        ->assertJsonPath('epoch', 0);
})->with([
    'writer' => [RoleRegistry::WRITER, 'rw'],
    'commenter' => [RoleRegistry::COMMENTER, 'ro'],
]);

it('answers allowed=false when the user has no access to the node', function (): void {
    $node = Hub::document(level: null);

    Hub::call('authenticate', ['room' => Hub::room($node)], Hub::token($node))
        ->assertOk()
        ->assertJsonPath('allowed', false);
});

it('denies authentication with the published body after View is revoked while load remains hidden', function (): void {
    ['drive' => $drive, 'folder' => $folder, 'grant' => $grant, 'node' => $node] = Revocation::inheritedDocument();
    $token = Hub::token($node);
    $room = Hub::room($node);
    Hub::call('authenticate', ['room' => $room], $token)->assertOk()->assertJsonPath('allowed', true);

    $drive->access()->revoke($folder->id, $grant);

    Hub::call('authenticate', ['room' => $room], $token)->assertOk()
        ->assertExactJson(['allowed' => false, 'mode' => 'ro', 'userId' => null]);
    Hub::call('load', ['room' => $room], $token)->assertNotFound()->assertJsonPath('code', 'node_not_found');
    expect(Compaction::head($node))->toBeNull();
});

// ── content this installation cannot save back ──────────────────────────────────────
//
// Both hooks answer from the same rule as DocumentOperations::update(): a type that is
// not installed, content written in a newer schema, or content the type reads only
// partly is shown, never overwritten — not by the Yjs state, not by a projection.

/** @return array<string, mixed> */
function collabWidgetDocument(): array
{
    return ['type' => 'doc', 'content' => [
        ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'before']]],
        ['type' => 'acmeWidget'],
    ]];
}

function degradedWebhookNode(): Node
{
    config()->set('vaulter-documents.tiptap.extra_nodes', ['acmeWidget']);
    $node = Hub::document(content: TipTapContent::fromArray(collabWidgetDocument()));
    // The host switches the extension off: the widget no longer reads.
    config()->set('vaulter-documents.tiptap.extra_nodes', []);

    return $node;
}

dataset('unwritable collaboration documents', [
    'degraded read' => [fn (): Node => degradedWebhookNode(), null],
    'newer schema' => [fn (): Node => Hub::document(schemaVersion: 2), 'unsupported_binding'],
    'type not installed' => [fn (): Node => Hub::documentOfRemovedType(), 'unsupported_binding'],
]);

it('authenticates an editor read-only on content that cannot be saved back', function (Closure $node, ?string $unavailable): void {
    $node = $node();

    $response = Hub::call('authenticate', ['room' => Hub::room($node)], Hub::token($node));
    if ($unavailable !== null) {
        // Unsupported stored bindings cannot be opened even in read mode.
        $response->assertStatus(409)->assertJsonPath('code', 'collaboration_unavailable')
            ->assertJsonPath('meta.context.reason', $unavailable);

        return;
    }
    $response
        ->assertOk()
        ->assertJsonPath('allowed', true)
        ->assertJsonPath('mode', 'ro');
})->with('unwritable collaboration documents');

it('refuses an append over content that cannot be saved back', function (Closure $node, ?string $unavailable): void {
    $node = $node();
    $before = Hub::aggregate($node);

    // The room is read-only (authenticate above): nothing of it is appended, so no checkpoint can overwrite the content.
    $response = Hub::call('append', Hub::seedBody($node, 'room-without-widget'), Hub::token($node));
    $response->assertStatus($unavailable === null ? 403 : 409)
        ->assertJsonPath('code', $unavailable === null ? 'permission_denied' : 'collaboration_unavailable');
    if ($unavailable !== null) {
        $response->assertJsonPath('meta.context.reason', $unavailable);
    }

    $after = Hub::aggregate($node);
    expect($after->content)->toBe($before->content)
        ->and($after->collab_state)->toBeNull()
        ->and($after->pending_through_seq)->toBeNull()
        ->and($after->schema_version)->toBe($before->schema_version)
        ->and($after->state_version)->toBe($before->state_version)
        ->and(Compaction::head($node))->toBeNull();
})->with('unwritable collaboration documents');

it('refuses every hub call for a type that cannot collaborate', function (): void {
    DocumentTestHelpers::installTypes([RichTextDocumentType::class, MarkdownDocumentType::class, AcmeKanbanV2Type::class]);
    $node = Hub::document(content: OpaqueContent::fromArray(['columns' => []]), type: 'acme/kanban', schemaVersion: 2);

    foreach (['authenticate', 'load'] as $endpoint) {
        Hub::call($endpoint, ['room' => Hub::room($node)], Hub::token($node))
            ->assertStatus(409)
            ->assertJsonPath('code', 'collaboration_unavailable');
    }
    Hub::call('append', Hub::appendBody($node, 'board-room'), Hub::token($node))
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_unavailable');
});

it('decodes a checkpoint projection with the document type\'s own schema', function (): void {
    $empty = ['type' => 'doc', 'content' => []];
    $node = Hub::document(content: TipTapContent::fromArray($empty, TipTapSchema::markdown()), type: 'vaulter/markdown');
    Hub::call('append', Hub::seedBody($node, 'markdown-room'), Hub::token($node))->assertOk();

    // A table is rich text, not markdown: publishing it would leave the document degraded.
    $table = ['type' => 'doc', 'content' => [
        ['type' => 'table', 'content' => [['type' => 'tableRow', 'content' => [['type' => 'tableCell']]]]],
    ]];

    expect(fn (): CheckpointResult => Compaction::publish(Compaction::leaseOf($node), overrides: ['content' => $table]))
        ->toThrow(InvalidDocumentContentException::class);

    $state = Hub::aggregate($node);
    expect($state->content)->toBe($empty)
        ->and($state->collab_state)->toBeNull();
});
