<?php

declare(strict_types=1);

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\Persistence\AppendResult;
use Vaulter\Collaboration\Persistence\RetiredGenerations;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Documents\Actions\Revisions\RestoreDocumentRevisionAction;
use Vaulter\Documents\Data\Revisions\RestoreDocumentRevisionInput;
use Vaulter\Documents\Models\Revisions\DocumentRevision;
use Vaulter\Drive\Models\Node;

/*
 * Scenario 6: receipts outlive the compaction of their payloads and live as long as their generation:
 * a retry of a compacted update still gets its seq. A restore closes the generation (retired_at); a late retry of it is
 * refused with collaboration_epoch_mismatch, and the same before and after the prune, which deletes the closed
 * generation's rows only once token_ttl + the retry horizon + retention.retired_generation_days have passed. The
 * document's current generation is never pruned.
 */

function retentionRestore(Node $node): void
{
    $first = DocumentRevision::query()->where('document_id', Hub::aggregate($node)->getKey())->orderBy('number')->firstOrFail();
    app(RestoreDocumentRevisionAction::class)->execute(DocumentTestHelpers::context($node, actorId: 1), new RestoreDocumentRevisionInput(node: $node, revision: $first));
}

/** Compacts everything the document's current generation holds. */
function retentionCompact(Node $node): void
{
    Compaction::publish(Compaction::leaseOf($node));
}

/** @return array{generations: int, updates: int, receipts: int} */
function retentionPrune(): array
{
    return app(RetiredGenerations::class)->prune(Carbon::now()->subSeconds(app(CollaborationOptions::class)->retiredGenerationGraceSeconds()));
}

function retentionRows(string $entity, int $generation): int
{
    return DB::table(app(DatabaseOptions::class)->table($entity))->where('generation', $generation)->count();
}

beforeEach(function (): void {
    Hub::configure();
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $this->node = Hub::document();
    $this->id = (string) Str::uuid();
});

it('answers a retry of a compacted update from its receipt, with its seq and no new row', function (): void {
    Compaction::append($this->node, 'u1', updateId: $this->id);
    Compaction::append($this->node, 'u2');
    retentionCompact($this->node);

    $retry = Compaction::append($this->node, 'u1', updateId: $this->id);

    expect($retry->duplicate)->toBeTrue()
        ->and($retry->seq)->toBe(1)
        ->and(Compaction::seqs($this->node))->toBe([])
        ->and(Compaction::rows('collaboration_receipts'))->toBe(2)
        ->and(Compaction::marker($this->node))->toBe([null, null]);
});

it('closes the generation a restore leaves and refuses its late retry the same before and after the prune', function (): void {
    Compaction::append($this->node, 'u1', updateId: $this->id);
    retentionCompact($this->node);
    retentionRestore($this->node);

    $closed = Compaction::head($this->node, 0);
    expect(Hub::aggregate($this->node)->collab_epoch)->toBe(1)
        ->and($closed?->retiredAt)->not->toBeNull()
        ->and(retentionRows('collaboration_receipts', 0))->toBe(1);

    $late = fn (): AppendResult => Compaction::append($this->node, 'u1', generation: 0, updateId: $this->id);
    expect($late)->toThrow(CollaborationEpochMismatchException::class);

    // Within the grace the receipts stay.
    $this->travel(app(CollaborationOptions::class)->retiredGenerationGraceSeconds() - 5)->seconds();
    expect(retentionPrune())->toBe(['generations' => 0, 'updates' => 0, 'receipts' => 0])
        ->and(retentionRows('collaboration_receipts', 0))->toBe(1)
        ->and($late)->toThrow(CollaborationEpochMismatchException::class);

    $this->travel(10)->seconds();
    expect(retentionPrune())->toBe(['generations' => 1, 'updates' => 0, 'receipts' => 1])
        ->and(retentionRows('collaboration_receipts', 0))->toBe(0)
        ->and(retentionRows('collaboration_heads', 0))->toBe(0)
        ->and($late)->toThrow(CollaborationEpochMismatchException::class)
        ->and(retentionRows('collaboration_receipts', 0))->toBe(0);
});

it('waits token_ttl, the retry horizon and the retention days before a closed generation may go', function (): void {
    config()->set('vaulter-collaboration.hub.token_ttl', 240);
    config()->set('vaulter-collaboration.retention.retired_generation_days', 2);

    expect(app(CollaborationOptions::class)->retiredGenerationGraceSeconds())->toBe(240 + 10 + 2 * 86400);
});

it('keeps the receipts of the current generation however old they are', function (): void {
    Compaction::append($this->node, 'u1', updateId: $this->id);
    retentionCompact($this->node);
    $this->travel(400)->days();

    expect(retentionPrune())->toBe(['generations' => 0, 'updates' => 0, 'receipts' => 0])
        ->and(Compaction::append($this->node, 'u1', updateId: $this->id)->seq)->toBe(1);
});

it('never prunes the document\'s current generation, even one marked retired', function (): void {
    Compaction::append($this->node, 'u1');
    DB::table(app(DatabaseOptions::class)->table('collaboration_heads'))->update(['retired_at' => now()->subYears(2)]);

    expect(retentionPrune())->toBe(['generations' => 0, 'updates' => 0, 'receipts' => 0])
        ->and(retentionRows('collaboration_updates', 0))->toBe(1)
        ->and(retentionRows('collaboration_receipts', 0))->toBe(1);
});

it('prunes the updates a closed generation still held with it', function (): void {
    Compaction::append($this->node, 'u1');
    // Closed with its payload still in the log (the marker was cleared without a compaction).
    Hub::aggregate($this->node)->forceFill(['pending_generation' => null, 'pending_through_seq' => null, 'pending_protocol' => null, 'pending_state_format' => null, 'pending_schema_version' => null])->save();
    retentionRestore($this->node);
    $this->travel(app(CollaborationOptions::class)->retiredGenerationGraceSeconds() + 1)->seconds();

    expect(retentionPrune())->toBe(['generations' => 1, 'updates' => 1, 'receipts' => 1])
        ->and(Compaction::rows('collaboration_updates'))->toBe(0);
});
