<?php

declare(strict_types=1);

use Illuminate\Support\Carbon;
use Illuminate\Support\Sleep;
use Vaulter\Collaboration\Persistence\AppendResult;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Collaboration\Tests\Support\FakeHub;
use Vaulter\Documents\Exceptions\DocumentStatePendingException;
use Vaulter\Documents\Facades\Documents;
use Vaulter\Documents\State\PendingStateDrainer;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\Http\Support\RepresentationTag;
use Vaulter\Kernel;

/*
 * Scenario 18: a restore or a REST replace of a document with saved but uncheckpointed edits first drains them
 * through the hub: outside any transaction the backend asks for a compaction (drain_requested_at), the hub's worker
 * leases the generation, merges and publishes the checkpoint, and the restore then takes its locks again, finds the
 * marker gone, keeps the drained state as a revision and closes the generation (G+1, retired_at). Every saved receipt
 * is in that revision. With the hub silent the drain runs into its deadline (10 s): 409 document_state_pending, the
 * generation stays and no receipt or update is lost.
 *
 * The fake hub (tests/Support/FakeHub.php) takes the lease and publishes over HTTP; its merge concatenates payloads.
 */

/** @return list<string|null> the binary state of each revision, oldest first */
function pendingRevisionStates(mixed $node): array
{
    return DocumentTestHelpers::revisions($node)->pluck('collab_state')->all();
}

beforeEach(function (): void {
    Hub::configure();
    $this->node = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
    $this->id = (string) $this->node->getKey();
    $this->documents = Documents::in(Vaulter::drive($this->node->storage()->firstOrFail())->actingAs(AccessTestHelpers::user(1)));
    $this->first = $this->documents->revisions($this->id)->items[0]->id;
});

it('provides the drainer of the documents while the module is active', function (): void {
    expect(app(Kernel::class)->extensions()->handlerKeys(PendingStateDrainer::class) !== [])->toBeTrue();
});

it('drains the saved edits through the hub, keeps them in a revision and closes the generation on a restore', function (): void {
    FakeHub::install();
    $receipts = array_map(fn (string $payload): AppendResult => Compaction::append($this->node, $payload), ['u1', 'u2', 'u3']);
    $through = max(array_map(static fn (AppendResult $receipt): int => $receipt->seq, $receipts));

    $this->documents->restore($this->id, $this->first);

    $document = Hub::aggregate($this->node);
    $closed = Compaction::head($this->node, 0);
    expect(FakeHub::$drains)->toBe([['node' => $this->id, 'transactionLevel' => 0]])
        ->and(array_column(FakeHub::$published, 'status'))->toBe([200])
        ->and(FakeHub::$published[0]['body']['marker_cleared'])->toBeTrue()
        // Every saved receipt is covered by the checkpoint the revision keeps.
        ->and($closed?->checkpointSeq)->toBeGreaterThanOrEqual($through)
        ->and(pendingRevisionStates($this->node))->toContain('u1u2u3')
        ->and(Compaction::rows('collaboration_receipts'))->toBe(3)
        ->and($document->collab_epoch)->toBe(1)
        ->and($closed?->retiredAt)->not->toBeNull()
        ->and([$document->pending_generation, $document->pending_through_seq])->toBe([null, null])
        ->and(data_get($document->content, 'content.0.content.0.text'))->toBe('Draft');
});

it('refuses the restore with 409 when the hub does not answer, and keeps the generation and its log', function (): void {
    FakeHub::install(online: false);
    Sleep::fake(syncWithCarbon: true);
    Compaction::append($this->node, 'u1');
    Compaction::append($this->node, 'u2');
    $before = Hub::aggregate($this->node);
    $started = Carbon::now();

    expect(fn () => $this->documents->restore($this->id, $this->first))->toThrow(DocumentStatePendingException::class);

    $after = Hub::aggregate($this->node);
    expect(FakeHub::$drains)->toHaveCount(1)
        ->and(FakeHub::$drains[0]['transactionLevel'])->toBe(0)
        // The drain waited its whole deadline before the restore gave up.
        ->and($started->diffInSeconds(Carbon::now()))->toBeGreaterThanOrEqual(10.0)
        ->and($after->collab_epoch)->toBe(0)
        ->and($after->state_version)->toBe($before->state_version)
        ->and($after->revision_count)->toBe($before->revision_count)
        ->and([$after->pending_generation, $after->pending_through_seq])->toBe([0, 2])
        ->and(Compaction::rows('collaboration_receipts'))->toBe(2)
        ->and(Compaction::seqs($this->node))->toBe([1, 2])
        ->and(Compaction::head($this->node, 0)?->retiredAt)->toBeNull()
        ->and(Compaction::head($this->node, 0)?->drainRequestedAt)->not->toBeNull();
});

it('answers the REST restore with 409 document_state_pending when the drain misses its deadline', function (): void {
    FakeHub::install(online: false);
    Sleep::fake(syncWithCarbon: true);
    $this->actingAs(AccessTestHelpers::user(1));
    $document = Hub::aggregate($this->node);
    $tag = RepresentationTag::document($this->id, $document->collab_epoch, $document->state_version);
    Compaction::append($this->node, 'u1');

    $this->postJson(Docs::url('documents/'.$this->id.'/revisions/'.$this->first.'/restore'), [], ['If-Match' => $tag])
        ->assertStatus(409)
        ->assertJsonPath('code', 'document_state_pending')
        ->assertJsonPath('retryable', 'with_backoff');

    expect(Hub::aggregate($this->node)->collab_epoch)->toBe(0)
        ->and(Compaction::rows('collaboration_receipts'))->toBe(1);
});

it('drains before a REST replace, keeps the drained edits in a revision and closes the generation', function (): void {
    FakeHub::install();
    Compaction::append($this->node, 'u1');
    Compaction::append($this->node, 'u2');

    $this->documents->update($this->id, DocumentTestHelpers::content('Mine')->toArray());

    $document = Hub::aggregate($this->node);
    expect(FakeHub::$drains)->toHaveCount(1)
        ->and(pendingRevisionStates($this->node))->toContain('u1u2')
        ->and($document->collab_epoch)->toBe(1)
        ->and($document->collab_state)->toBeNull()
        ->and(data_get($document->content, 'content.0.content.0.text'))->toBe('Mine')
        ->and(Compaction::head($this->node, 0)?->retiredAt)->not->toBeNull()
        ->and(Compaction::rows('collaboration_receipts'))->toBe(2);
});

it('drains before serving the working state, without closing the generation', function (): void {
    FakeHub::install();
    Compaction::append($this->node, 'u1');

    $snapshot = $this->documents->content($this->id);

    expect(data_get($snapshot->content->toArray(), 'content.0.content.0.text'))->toBe('Compacted through 1')
        ->and(Hub::aggregate($this->node)->collab_epoch)->toBe(0)
        ->and(Compaction::head($this->node, 0)?->retiredAt)->toBeNull()
        ->and(Compaction::head($this->node, 0)?->drainRequestedAt)->toBeNull();
});

it('asks for no drain and waits for nothing when the document carries no marker', function (): void {
    FakeHub::install();

    $this->documents->restore($this->id, $this->first);

    expect(FakeHub::$drains)->toBe([])
        ->and(Hub::aggregate($this->node)->collab_epoch)->toBe(1);
});
