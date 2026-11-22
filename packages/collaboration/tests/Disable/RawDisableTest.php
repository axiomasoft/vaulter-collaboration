<?php

declare(strict_types=1);

use Illuminate\Contracts\Console\Kernel as ConsoleKernel;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Vaulter\Collaboration\CollaborationModule;
use Vaulter\Collaboration\Schema\CollaborationSchema;
use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Actions\Documents\CreateDocumentAction;
use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Documents\Exceptions\DocumentStatePendingException;
use Vaulter\Documents\Facades\Documents;
use Vaulter\Documents\Models\Documents\Document;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\PendingStateDrainer;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Http\Support\RepresentationTag;
use Vaulter\Kernel;
use Vaulter\Testing\Fixtures\TestUser;

/*
 * Scenario 12, raw disable: the module is switched off with `vaulter.modules.collaboration=false`
 * (here: its default) while documents still carry a pending marker — no drain ran. Nothing is compacted: the documents
 * module answers 409 document_state_pending for exactly those documents (content, replace, restore, export), the others
 * work, and the log stays as it was. Not one query reaches a `v_collaboration_*` table and not one service of the
 * collaboration package is built (query and resolution spies, as in ActivationMatrixTest): no drainer is selected.
 */

function rawDisableDocument(string $text): Node
{
    $drive = DocumentTestHelpers::drive();

    return app(CreateDocumentAction::class)->execute(DocumentTestHelpers::context($drive->model()), new CreateDocumentInput(
        storage: $drive->model(),
        name: $text,
        content: DocumentTestHelpers::content($text),
        parent: DriveTestHelpers::model($drive->root()),
    ));
}

/** The state an active module left behind: a marker through seq 2 and the log of the generation that holds it. */
function rawDisableLeftPending(Node $node): void
{
    app(VaulterDatabase::class)->transaction(static function () use ($node): void {
        $state = app(CollaborativeState::class);
        $locked = $state->lock($node->getKey());
        $state->markPending($locked, $locked->binding, 2);
    });
    $document = Document::query()->where('node_id', $node->getKey())->firstOrFail();
    $key = ['document_id' => $document->getKey(), 'generation' => $document->collab_epoch];
    $now = Carbon::now();
    DB::table('v_collaboration_heads')->insert($key + ['head_seq' => 2, 'checkpoint_seq' => 0, 'checkpoint_version' => $document->state_version, 'created_at' => $now, 'updated_at' => $now]);
    foreach ([1, 2] as $seq) {
        $id = sprintf('00000000-0000-4000-8000-%012d', $seq);
        DB::table('v_collaboration_updates')->insert($key + ['seq' => $seq, 'update_id' => $id, 'payload' => base64_encode('u'.$seq), 'sha256' => hash('sha256', 'u'.$seq), 'created_at' => $now]);
        DB::table('v_collaboration_receipts')->insert($key + ['update_id' => $id, 'seq' => $seq, 'sha256' => hash('sha256', 'u'.$seq), 'committed_at' => $now]);
    }
}

/**
 * The services of the collaboration package the container built. The kernel reads the manifest and the schema
 * descriptor of every installed module, an inactive one too (ModuleSchemas, architecture#module-system: schema and
 * diagnostic descriptors are allowed); nothing else of the package may be built.
 *
 * @param  list<string> $resolved
 * @return list<string>
 */
function rawDisableServices(array $resolved): array
{
    $descriptors = [CollaborationModule::class, CollaborationSchema::class];

    return array_values(array_filter($resolved, static fn (string $class): bool => str_starts_with($class, 'Vaulter\\Collaboration\\')
        && !str_starts_with($class, 'Vaulter\\Collaboration\\Tests\\')
        && !in_array($class, $descriptors, true)));
}

/**
 * @param  list<string> $queries
 * @return list<string> the queries that reached a table of the collaboration log
 */
function rawDisableLogQueries(array $queries): array
{
    return array_values(array_filter($queries, static fn (string $sql): bool => str_contains($sql, 'collaboration_')));
}

/** @return array{updates: int, receipts: int, heads: int} */
function rawDisableLog(): array
{
    return [
        'updates' => DB::table('v_collaboration_updates')->count(),
        'receipts' => DB::table('v_collaboration_receipts')->count(),
        'heads' => DB::table('v_collaboration_heads')->count(),
    ];
}

beforeEach(function (): void {
    $this->user = (new TestUser)->forceFill(['id' => 1]);
    $this->actingAs($this->user);
    $this->pending = rawDisableDocument('Pending');
    $this->other = rawDisableDocument('Settled');
    rawDisableLeftPending($this->pending);
    $this->id = (string) $this->pending->getKey();
    $this->documents = Documents::in(Vaulter::drive($this->pending->storage()->firstOrFail())->actingAs($this->user));
    $this->revision = $this->documents->revisions($this->id)->items[0]->id;
    $document = Document::query()->where('node_id', $this->pending->getKey())->firstOrFail();
    $this->tag = RepresentationTag::document($this->id, $document->collab_epoch, $document->state_version);

    // The spies start once the leftover state is in place.
    $this->queries = [];
    $this->resolved = [];
    DB::listen(function (QueryExecuted $query): void {
        $this->queries[] = $query->sql;
    });
    $this->app->resolving(function (mixed $object): void {
        if (is_object($object)) {
            $this->resolved[] = $object::class;
        }
    });
});

it('is switched off and selects no drainer, and brings no drain command', function (): void {
    $kernel = app(Kernel::class);

    expect($kernel->isActive('collaboration'))->toBeFalse()
        ->and($kernel->extensions()->handlerKeys(PendingStateDrainer::class) !== [])->toBeFalse()
        ->and(app(ConsoleKernel::class)->all())->not->toHaveKey('vaulter:collaboration:drain');
});

it('answers 409 document_state_pending for the pending document on every path that reads or replaces its state, without a query or a service of collaboration', function (): void {
    $base = 'documents/'.$this->id;

    $this->getJson(Docs::url($base.'/content'))
        ->assertStatus(409)
        ->assertJsonPath('code', 'document_state_pending')
        ->assertJsonPath('retryable', 'with_backoff')
        ->assertJsonPath('meta.node_id', $this->id);
    $this->putJson(Docs::url($base.'/content'), ['content' => Docs::doc('Over it')], ['If-Match' => $this->tag])
        ->assertStatus(409)
        ->assertJsonPath('code', 'document_state_pending');
    $this->postJson(Docs::url($base.'/revisions/'.$this->revision.'/restore'), [], ['If-Match' => $this->tag])
        ->assertStatus(409)
        ->assertJsonPath('code', 'document_state_pending');
    $this->getJson(Docs::url($base.'/export/markdown'))
        ->assertStatus(409)
        ->assertJsonPath('code', 'document_state_pending');
    expect(fn () => $this->documents->content($this->id))->toThrow(DocumentStatePendingException::class);

    $document = Document::query()->where('node_id', $this->pending->getKey())->firstOrFail();
    expect([$document->pending_generation, $document->pending_through_seq])->toBe([0, 2])
        ->and($document->collab_epoch)->toBe(0)
        ->and(data_get($document->content, 'content.0.content.0.text'))->toBe('Pending')
        ->and(rawDisableLogQueries($this->queries))->toBe([])
        ->and(rawDisableServices($this->resolved))->toBe([])
        ->and(rawDisableLog())->toBe(['updates' => 2, 'receipts' => 2, 'heads' => 1]);
});

it('refuses vaulter:module:uninstall collaboration --force --purge of the switched-off module while the marker stays', function (): void {
    // The guard is named by the manifest class statically and reads the documents' markers: it answers for an inactive module.
    $this->artisan('vaulter:module:uninstall', ['module' => 'collaboration', '--force' => true, '--purge' => true])
        ->expectsOutputToContain('collaboration (inactive)')
        ->expectsOutputToContain('module "collaboration" refuses it: 1 document(s) with saved collaboration edits not in a checkpoint yet')
        ->expectsOutputToContain('nothing was changed')
        ->assertExitCode(1);

    expect(rawDisableLog())->toBe(['updates' => 2, 'receipts' => 2, 'heads' => 1])
        ->and(DB::table('migrations')->where('migration', 'like', '%create_v_collaboration_%')->count())->toBe(4);
});

it('serves and replaces a document without a marker as usual, still without collaboration', function (): void {
    $other = (string) $this->other->getKey();

    $this->getJson(Docs::url('documents/'.$other.'/content'))
        ->assertOk()
        ->assertJsonPath('data.content.content.0.content.0.text', 'Settled');
    Docs::put($other, Docs::doc('Edited'))->assertOk();

    expect(rawDisableLogQueries($this->queries))->toBe([])
        ->and(rawDisableServices($this->resolved))->toBe([]);
});
