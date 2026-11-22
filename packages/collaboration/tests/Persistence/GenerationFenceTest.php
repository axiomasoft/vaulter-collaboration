<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentsV1;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Actions\Revisions\RestoreDocumentRevisionAction;
use Vaulter\Documents\Data\Revisions\RestoreDocumentRevisionInput;
use Vaulter\Documents\Exceptions\CollaborationUnavailableException;
use Vaulter\Documents\Exceptions\DocumentStatePendingException;
use Vaulter\Documents\Fixtures\HistoricalRichTextType;
use Vaulter\Documents\Models\Revisions\DocumentRevision;
use Vaulter\Documents\Types\DocumentTypeRegistry;
use Vaulter\Documents\Types\MarkdownDocumentType;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;

/*
 * Scenario 7: only the document's current generation takes appends. A restore between the hub's load and its
 * append moves the generation on, and the append of the old one is refused with collaboration_epoch_mismatch and
 * writes nothing; a retired generation refuses every append. A restore never closes a generation over saved edits it
 * has not checkpointed (document_state_pending).
 */

function fenceAppend(Node $node, int $generation, string $payload = 'update', bool $seed = false): mixed
{
    return app(UpdateLog::class)->append($node->getKey(), new UpdateEnvelope(
        generation: $generation,
        updateId: (string) Str::uuid(),
        payload: $payload,
        claimedSha256: hash('sha256', $payload),
        origin: $seed ? 'server' : 'client',
        seedStateVersion: $seed ? Hub::aggregate($node)->state_version : null,
    ));
}

function fenceRestore(Node $node): void
{
    $first = DocumentRevision::query()->where('document_id', Hub::aggregate($node)->getKey())->orderBy('number')->firstOrFail();
    app(RestoreDocumentRevisionAction::class)->execute(DocumentTestHelpers::context($node, actorId: 1), new RestoreDocumentRevisionInput(node: $node, revision: $first));
}

function fenceRows(string $entity): int
{
    return DB::table(app(DatabaseOptions::class)->table($entity))->count();
}

/** @return array<string, mixed> */
function fenceStoredAttributes(Node $node): array
{
    return array_map(static function (mixed $value): mixed {
        if (!is_resource($value)) {
            return $value;
        }
        // PDO returns bytea as a fresh stream on each read: compare every stored byte, not resource identities.
        $position = ftell($value);
        $seekable = stream_get_meta_data($value)['seekable'];
        try {
            $bytes = stream_get_contents($value, offset: $seekable ? 0 : -1);
        } finally {
            if ($seekable && $position !== false) {
                fseek($value, $position);
            }
        }

        return $bytes === false ? throw new RuntimeException('Unable to read stored aggregate bytes.') : $bytes;
    }, Hub::aggregate($node)->getAttributes());
}

beforeEach(function (): void {
    Hub::configure();
    $this->node = Hub::document();
});

it('refuses an append of the generation a restore closed between load and append', function (): void {
    // The hub loaded generation 0; a restore commits before its first append.
    $loaded = Hub::aggregate($this->node)->collab_epoch;
    fenceRestore($this->node);

    expect(fn (): mixed => fenceAppend($this->node, $loaded))->toThrow(CollaborationEpochMismatchException::class)
        ->and(Hub::aggregate($this->node)->collab_epoch)->toBe($loaded + 1)
        ->and(fenceRows('collaboration_updates'))->toBe(0)
        ->and(fenceRows('collaboration_receipts'))->toBe(0)
        ->and(Hub::aggregate($this->node)->pending_generation)->toBeNull();
});

it('answers the hub the same 409 over HTTP for a room of the closed generation', function (): void {
    $token = Hub::token($this->node);
    $body = Hub::appendBody($this->node, 'update');
    fenceRestore($this->node);

    Hub::callV2('append', $body, $token)
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_epoch_mismatch');
    expect(fenceRows('collaboration_updates'))->toBe(0);
});

it('takes appends of the new generation after the restore, numbered from 1 again', function (): void {
    fenceAppend($this->node, 0, seed: true);
    // The saved edit of generation 0 is not checkpointed: the restore is refused and generation 0 keeps it.
    expect(fn () => fenceRestore($this->node))->toThrow(DocumentStatePendingException::class)
        ->and(Hub::aggregate($this->node)->collab_epoch)->toBe(0)
        ->and(fenceRows('collaboration_receipts'))->toBe(1);

    // Once the generation is clear (as a checkpoint would leave it), the restore closes it and the next one starts at 1.
    Hub::aggregate($this->node)->forceFill(['pending_generation' => null, 'pending_through_seq' => null, 'pending_protocol' => null, 'pending_state_format' => null, 'pending_schema_version' => null])->save();
    fenceRestore($this->node);
    $result = fenceAppend($this->node, 1, seed: true);

    expect($result->generation)->toBe(1)
        ->and($result->seq)->toBe(1)
        ->and(fenceRows('collaboration_heads'))->toBe(2);
});

it('refuses every append of a retired generation', function (): void {
    fenceAppend($this->node, 0, seed: true);
    DB::table(app(DatabaseOptions::class)->table('collaboration_heads'))->update(['retired_at' => now()]);

    expect(fn (): mixed => fenceAppend($this->node, 0, 'late'))->toThrow(CollaborationEpochMismatchException::class)
        ->and(fenceRows('collaboration_updates'))->toBe(1);
});

it('refuses an append of a generation the document never reached', function (): void {
    expect(fn (): mixed => fenceAppend($this->node, 5))->toThrow(CollaborationEpochMismatchException::class)
        ->and(fenceRows('collaboration_heads'))->toBe(0);
});

it('returns the full stored binding through both load and compaction lease without upgrading metadata', function (): void {
    $token = Hub::token($this->node);
    Hub::call('load', ['room' => Hub::room($this->node)], $token)->assertOk()
        ->assertJsonPath('protocol', 'yjs')->assertJsonPath('state_format', 'yjs-update-v1')->assertJsonPath('schema_version', 1)->assertJsonPath('generation', 0);
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    fenceAppend($this->node, 0, seed: true);
    $response = Hub::call('compaction/lease', ['hub_id' => 'binding-fixture'], null)->assertOk();
    $response->assertJsonPath('0.protocol', 'yjs')->assertJsonPath('0.state_format', 'yjs-update-v1')->assertJsonPath('0.schema_version', 1)->assertJsonPath('0.generation', 0);
});

it('refuses incompatible stored schema or format on load and lease with or without a checkpoint', function (bool $checkpoint, string $field, mixed $value): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    fenceAppend($this->node, 0, seed: true);
    if ($checkpoint) {
        Compaction::publish(Compaction::leaseOf($this->node));
        fenceAppend($this->node, 0, 'tail');
    }
    app(VaulterDatabase::class)->write(fn () => Hub::aggregate($this->node)->forceFill([$field => $value])->save());
    $before = fenceStoredAttributes($this->node);
    Hub::call('load', ['room' => Hub::room($this->node)], Hub::token($this->node))->assertStatus(409)->assertJsonPath('code', 'collaboration_unavailable');
    expect(fn (): array => Compaction::lease())->toThrow(CollaborationUnavailableException::class);
    expect(fenceStoredAttributes($this->node))->toBe($before)
        ->and(fenceRows('collaboration_updates'))->toBe(1);
})->with(['pre-seed schema' => [false, 'schema_version', 2], 'checkpoint schema' => [true, 'schema_version', 2], 'pre-seed format' => [false, 'collab_state_format', 'unsupported-v2'], 'checkpoint format' => [true, 'collab_state_format', 'unsupported-v2']]);

it('never serves or leases old bytes under a newly installed type schema or format', function (bool $checkpoint, string $changed): void {
    require_once __DIR__.'/../Support/HistoricalRichTextType.php';
    $type = new HistoricalRichTextType;
    $registry = new DocumentTypeRegistry(app());
    foreach ([new MarkdownDocumentType, $type] as $registered) {
        $registry->register($registered);
    }
    $registry->freeze();
    app()->instance(DocumentTypeRegistry::class, $registry);
    $node = Hub::document(content: $type->defaultContent(), type: $type->key());
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    fenceAppend($node, 0, seed: true);
    if ($checkpoint) {
        Compaction::publish(Compaction::leaseOf($node), overrides: ['content' => ['columns' => []]]);
        fenceAppend($node, 0, 'accepted-tail');
    }
    $token = Hub::token($node);
    $before = fenceStoredAttributes($node);
    if ($changed === 'schema') {
        $type->version = 2;
    } else {
        $type->format = 'yjs-update-v2';
    }
    if ($changed === 'schema') {
        $this->actingAs(AccessTestHelpers::user(1));
        $this->postJson(DocumentsV1::url('documents/'.$node->getKey().'/collaboration/session'))->assertCreated()->assertJsonPath('data.mode', 'read')->assertJsonPath('data.schema_version', 1);
        Hub::call('load', ['room' => Hub::room($node)], $token)->assertOk()->assertJsonPath('schema_version', 1);
        Hub::callV2('append', Hub::appendBody($node, 'disallowed-write'), $token)->assertForbidden();
        $lease = Compaction::leaseOf($node);
        Compaction::publish($lease, overrides: ['content' => ['columns' => []]]);
        expect(Compaction::marker($node))->toBe([null, null])->and(Hub::aggregate($node)->schema_version)->toBe(1)->and(Hub::aggregate($node)->collab_epoch)->toBe($before['collab_epoch']);
        $later = Hub::document(type: 'vaulter/markdown');
        Hub::callV2('append', Hub::seedBody($later, 'later-seed'), Hub::token($later))->assertOk();
        Compaction::publish(Compaction::leaseOf($later));
        expect(Compaction::marker($later))->toBe([null, null]);

        return;
    }
    Hub::call('load', ['room' => Hub::room($node)], $token)->assertStatus(409)->assertJsonPath('code', 'collaboration_unavailable');
    expect(fn (): array => Compaction::lease())->toThrow(CollaborationUnavailableException::class);
    expect(fenceStoredAttributes($node))->toBe($before)->and(Hub::aggregate($node)->schema_version)->toBe(1)->and(Hub::aggregate($node)->collab_state_format)->toBe('yjs-update-v1');
})->with(['pre-seed schema change' => [false, 'schema'], 'checkpoint schema change' => [true, 'schema'], 'pre-seed format change' => [false, 'format'], 'checkpoint format change' => [true, 'format']]);

it('serves Markdown session load lease checkpoint and drain for both checkpoint states', function (bool $checkpoint): void {
    $node = Hub::document(type: 'vaulter/markdown');
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $this->actingAs(AccessTestHelpers::user(1));
    $this->postJson(DocumentsV1::url('documents/'.$node->getKey().'/collaboration/session'))->assertCreated()->assertJsonPath('data.mode', 'write');
    $token = Hub::token($node);
    Hub::call('load', ['room' => Hub::room($node)], $token)->assertOk()->assertJsonPath('type', 'vaulter/markdown');
    Hub::callV2('append', Hub::seedBody($node, 'markdown-seed'), $token)->assertOk();
    if ($checkpoint) {
        Compaction::publish(Compaction::leaseOf($node));
        Compaction::append($node, 'tail');
    }
    $lease = Compaction::leaseOf($node);
    expect($lease->log->type)->toBe('vaulter/markdown')->and($lease->log->checkpoint !== null)->toBe($checkpoint);
    Compaction::publish($lease);
    Hub::call('load', ['room' => Hub::room($node)], $token)->assertOk()->assertJsonPath('schema_version', 1);
    expect(Compaction::marker($node))->toBe([null, null])->and(Hub::aggregate($node)->type)->toBe('vaulter/markdown');
})->with(['pre-seed' => [false], 'checkpoint' => [true]]);
