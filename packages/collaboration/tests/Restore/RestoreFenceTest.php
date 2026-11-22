<?php

declare(strict_types=1);

use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\Persistence\AppendResult;
use Vaulter\Collaboration\Persistence\CheckpointResult;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Collaboration\Tests\Support\FakeHub;
use Vaulter\Documents\Facades\Documents;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;

/*
 * Scenario 13: a restore closes the generation it leaves — retired_at on its head, in the restore's transaction —
 * and nothing of that generation is accepted afterwards: an append, a lease, and the publication of a checkpoint the
 * hub merged under a lease the restore outlived all answer collaboration_epoch_mismatch or find nothing, and change
 * neither the restored state nor the closed log. A REST replace that moves the generation closes it the same way.
 */

beforeEach(function (): void {
    Hub::configure();
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $this->node = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
    $this->id = (string) $this->node->getKey();
    $this->documents = Documents::in(Vaulter::drive($this->node->storage()->firstOrFail())->actingAs(AccessTestHelpers::user(1)));
    $this->first = $this->documents->revisions($this->id)->items[0]->id;
});

it('refuses the publication of a lease the restore outlived and changes nothing', function (): void {
    Compaction::append($this->node, 'u1');
    // A hub leased generation 0 and stalled; its lease ran out before the restore's drain leased it again.
    $stale = Compaction::leaseOf($this->node, 'hub-slow');
    $this->travel(61)->seconds();
    FakeHub::install();
    $this->documents->restore($this->id, $this->first);
    $restored = Hub::aggregate($this->node);
    $closed = Compaction::head($this->node, 0);

    expect(fn (): CheckpointResult => Compaction::publish($stale))->toThrow(CollaborationEpochMismatchException::class);

    $after = Hub::aggregate($this->node);
    expect($restored->collab_epoch)->toBe(1)
        ->and($after->state_version)->toBe($restored->state_version)
        ->and($after->collab_state)->toBe($restored->collab_state)
        ->and($after->revision_count)->toBe($restored->revision_count)
        ->and(Compaction::head($this->node, 0))->toEqual($closed)
        ->and($closed?->retiredAt)->not->toBeNull()
        ->and(Compaction::rows('collaboration_receipts'))->toBe(1);
});

it('refuses appends, leases and checkpoints of the generation a restore closed', function (): void {
    Compaction::append($this->node, 'u1');
    FakeHub::install();
    $this->documents->restore($this->id, $this->first);
    $closed = Compaction::head($this->node, 0);

    expect(fn (): AppendResult => Compaction::append($this->node, 'late', generation: 0))->toThrow(CollaborationEpochMismatchException::class)
        ->and(Compaction::lease())->toBe([]);
    Hub::callV2('checkpoint', [
        'document' => $this->id,
        'generation' => 0,
        'lease_token' => str_repeat('a', 64),
        'covered_from' => 1,
        'covered_through' => 1,
        'protocol' => 'yjs',
        'state_format' => 'yjs-update-v1',
        'schema_version' => 1,
        'type' => 'vaulter/rich-text',
        'expected_checkpoint_version' => 1,
        'state' => base64_encode('late'),
        'content' => Hub::tiptap('Late'),
    ], token: null)
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_epoch_mismatch');

    expect(Compaction::head($this->node, 0))->toEqual($closed)
        ->and(Compaction::rows('collaboration_updates'))->toBe(0)
        ->and(Hub::aggregate($this->node)->collab_epoch)->toBe(1);
});

it('starts the next generation with an open log of its own', function (): void {
    Compaction::append($this->node, 'u1');
    FakeHub::install();
    $this->documents->restore($this->id, $this->first);

    $next = Compaction::append($this->node, 'n1');

    expect([$next->generation, $next->seq])->toBe([1, 1])
        ->and(Compaction::head($this->node, 1)?->retiredAt)->toBeNull()
        ->and(Compaction::head($this->node, 0)?->retiredAt)->not->toBeNull()
        ->and(Compaction::leaseOf($this->node)->log->generation)->toBe(1);
});

it('closes the generation a REST replace moves past, with no pending edits to drain', function (): void {
    Compaction::append($this->node, 'u1');
    Compaction::publish(Compaction::leaseOf($this->node));
    FakeHub::install();

    $this->documents->update($this->id, DocumentTestHelpers::content('Replaced')->toArray());

    expect(FakeHub::$drains)->toBe([])
        ->and(Hub::aggregate($this->node)->collab_epoch)->toBe(1)
        ->and(Compaction::head($this->node, 0)?->retiredAt)->not->toBeNull()
        ->and(fn (): AppendResult => Compaction::append($this->node, 'late', generation: 0))->toThrow(CollaborationEpochMismatchException::class);
});

it('leaves the current generation open when a checkpoint publication records its content event', function (): void {
    Compaction::append($this->node, 'u1');
    Compaction::publish(Compaction::leaseOf($this->node));

    expect(Compaction::head($this->node, 0)?->retiredAt)->toBeNull()
        ->and(Compaction::append($this->node, 'u2')->seq)->toBe(2);
});
