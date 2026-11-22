<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Vaulter\Collaboration\Exceptions\CollaborationCheckpointConflictException;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Collaboration\Persistence\CheckpointResult;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Events\Documents\DocumentContentUpdated;
use Vaulter\Documents\State\CollaborationStateBinding;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\Http\Support\RepresentationTag;

/*
 * Scenarios 4, 5 and 20: a checkpoint is published as one compare-and-set on the lease token, the checkpoint
 * sequence and version it started from and the head. On SQLite the race is an interleaving of calls (read H → append →
 * publish); the PostgreSQL race is tests/Concurrency/CompactionRaceTest.php.
 *
 * (4) An append committed after the lease read the log (seq H+1) survives a publication of H: its payload stays and the
 * marker (G, H+1) stays. (5) Of two publications of the same (C, H) the second loses with 409 and deletes nothing; the
 * log then holds HS − H updates. (20) While that marker stays, a REST replace answers 409 document_state_pending.
 */

/** @return array<string, mixed> what a lost publication must leave unchanged */
function casState(mixed $node): array
{
    $document = Hub::aggregate($node);

    return [
        'seqs' => Compaction::seqs($node),
        'receipts' => Compaction::rows('collaboration_receipts'),
        'head' => Compaction::head($node),
        'state_version' => $document->state_version,
        'collab_state' => $document->collab_state,
        'marker' => Compaction::marker($node),
        'revisions' => $document->revision_count,
    ];
}

beforeEach(function (): void {
    Hub::configure();
    // Every document with uncheckpointed edits is due at once.
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $this->node = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
});

it('keeps an update committed after the lease read the log, and its marker, when H is published (4)', function (): void {
    Compaction::append($this->node, 'u1', seed: true);
    Compaction::append($this->node, 'u2');
    $lease = Compaction::leaseOf($this->node);
    // The hub merges (C, H] = (0, 2] while a third update commits.
    $late = Compaction::append($this->node, 'u3');

    $result = Compaction::publish($lease);

    $document = Hub::aggregate($this->node);
    $head = Compaction::head($this->node);
    expect([$lease->log->checkpointSeq, $lease->log->headSeq])->toBe([0, 2])
        ->and($late->seq)->toBe(3)
        ->and($result->markerCleared)->toBeFalse()
        ->and($result->checkpointVersion)->toBe($document->state_version)
        ->and(Compaction::marker($this->node))->toBe([0, 3])
        ->and(Compaction::seqs($this->node))->toBe([3])
        ->and(Compaction::rows('collaboration_receipts'))->toBe(3)
        ->and($document->collab_state)->toBe('u1u2')
        ->and($head?->checkpointSeq)->toBe(2)
        ->and($head?->headSeq)->toBe(3)
        ->and($head?->checkpointVersion)->toBe($document->state_version)
        ->and($head?->leaseToken)->toBeNull();
});

it('compacts the late update with the next lease and clears the marker then', function (): void {
    Compaction::append($this->node, 'u1', seed: true);
    Compaction::append($this->node, 'u2');
    $first = Compaction::leaseOf($this->node);
    Compaction::append($this->node, 'u3');
    Compaction::publish($first);

    $second = Compaction::leaseOf($this->node);
    $result = Compaction::publish($second);

    expect([$second->log->checkpointSeq, $second->log->headSeq])->toBe([2, 3])
        ->and($second->log->checkpoint)->toBe('u1u2')
        ->and(array_column($second->log->tail, 'seq'))->toBe([3])
        ->and($second->checkpointVersion)->toBe($first->checkpointVersion + 1)
        ->and($result->markerCleared)->toBeTrue()
        ->and(Compaction::marker($this->node))->toBe([null, null])
        ->and(Compaction::seqs($this->node))->toBe([])
        ->and(Compaction::rows('collaboration_receipts'))->toBe(3)
        ->and(Hub::aggregate($this->node)->collab_state)->toBe('u1u2u3')
        ->and(Hub::aggregate($this->node)->content['content'][0]['content'][0]['text'])->toBe('Compacted through 3');
});

it('refuses the second publication of the same (C, H) and leaves HS − H updates (5)', function (): void {
    foreach (['u1', 'u2'] as $payload) {
        Compaction::append($this->node, $payload, seed: $payload === 'u1');
    }
    $lease = Compaction::leaseOf($this->node);
    Compaction::append($this->node, 'u3');
    Compaction::publish($lease);
    $after = casState($this->node);

    expect(fn (): CheckpointResult => Compaction::publish($lease))->toThrow(CollaborationCheckpointConflictException::class)
        ->and(casState($this->node))->toEqual($after)
        ->and(count(Compaction::seqs($this->node)))->toBe(3 - 2);
});

it('lets only one of two hubs publish (C, H) when the first lease expired under its merge', function (): void {
    Compaction::append($this->node, 'u1', seed: true);
    Compaction::append($this->node, 'u2');
    $slow = Compaction::leaseOf($this->node, 'hub-a');
    $this->travel(61)->seconds();
    $fast = Compaction::leaseOf($this->node, 'hub-b');

    Compaction::publish($fast);
    $after = casState($this->node);

    expect([$slow->log->checkpointSeq, $slow->log->headSeq])->toBe([$fast->log->checkpointSeq, $fast->log->headSeq])
        ->and(fn (): CheckpointResult => Compaction::publish($slow))->toThrow(CollaborationCheckpointConflictException::class)
        ->and(casState($this->node))->toEqual($after)
        ->and(Compaction::marker($this->node))->toBe([null, null]);
});

it('refuses a publication whose lease, coverage or version lost the CAS, changing and deleting nothing', function (array $overrides, string $reason): void {
    Compaction::append($this->node, 'u1', seed: true);
    Compaction::append($this->node, 'u2');
    $lease = Compaction::leaseOf($this->node);
    $before = casState($this->node);

    try {
        Compaction::publish($lease, overrides: $overrides);
        $this->fail('The publication was accepted.');
    } catch (CollaborationCheckpointConflictException $conflict) {
        expect($conflict->reason)->toBe($reason)
            ->and($conflict->httpStatus())->toBe(409)
            ->and($conflict->problemCode())->toBe('collaboration_checkpoint_conflict');
    }

    expect(casState($this->node))->toEqual($before)
        ->and(Compaction::seqs($this->node))->toBe([1, 2]);
})->with([
    'another token' => [['leaseToken' => str_repeat('0', 64)], CollaborationCheckpointConflictException::LEASE],
    'covered_from is not the checkpoint' => [['coveredFrom' => 1], CollaborationCheckpointConflictException::COVERAGE],
    'covered_through past the head' => [['coveredThrough' => 3], CollaborationCheckpointConflictException::COVERAGE],
    'another checkpoint version' => [['expectedCheckpointVersion' => 99], CollaborationCheckpointConflictException::VERSION],
]);

it('refuses a publication under an expired lease', function (): void {
    Compaction::append($this->node, 'u1', seed: true);
    $lease = Compaction::leaseOf($this->node);
    $before = casState($this->node);
    $this->travel(61)->seconds();

    expect(fn (): CheckpointResult => Compaction::publish($lease))->toThrow(CollaborationCheckpointConflictException::class)
        ->and(Compaction::seqs($this->node))->toBe([1])
        ->and(Compaction::marker($this->node))->toBe($before['marker']);
});

it('refuses a publication whose checkpoint version no longer is the document\'s state version', function (): void {
    Compaction::append($this->node, 'u1', seed: true);
    $lease = Compaction::leaseOf($this->node);
    // A write of the working state outside the log (the protocol 1 store) moved the state version.
    Hub::aggregate($this->node)->forceFill(['state_version' => Hub::aggregate($this->node)->state_version + 1])->save();

    expect(fn (): CheckpointResult => Compaction::publish($lease))->toThrow(CollaborationCheckpointConflictException::class)
        ->and(Compaction::seqs($this->node))->toBe([1]);
});

it('refuses a publication of another generation than the document\'s with the epoch conflict', function (): void {
    Compaction::append($this->node, 'u1', seed: true);
    $lease = Compaction::leaseOf($this->node);

    expect(fn (): CheckpointResult => Compaction::publish($lease, overrides: ['generation' => 1]))->toThrow(CollaborationEpochMismatchException::class)
        ->and(Compaction::seqs($this->node))->toBe([1]);
});

it('answers a REST replace with document_state_pending while the marker of the late update stays (20)', function (): void {
    $this->actingAs(AccessTestHelpers::user(1));
    Compaction::append($this->node, 'u1', seed: true);
    $lease = Compaction::leaseOf($this->node);
    Compaction::append($this->node, 'u2');
    Compaction::publish($lease);
    $document = Hub::aggregate($this->node);
    $tag = RepresentationTag::document((string) $this->node->getKey(), $document->collab_epoch, $document->state_version);

    Docs::put((string) $this->node->getKey(), Docs::doc('Replaced'), $tag)
        ->assertStatus(409)
        ->assertJsonPath('code', 'document_state_pending');

    expect(Compaction::marker($this->node))->toBe([0, 2])
        ->and(Compaction::seqs($this->node))->toBe([2])
        ->and(Hub::aggregate($this->node)->collab_epoch)->toBe(0)
        ->and(Hub::aggregate($this->node)->collab_state)->toBe('u1');
});

it('publishes and answers over HTTP with the new checkpoint version and the marker cleared', function (): void {
    Compaction::append($this->node, 'u1', seed: true);
    $lease = Compaction::leaseOf($this->node);
    $body = [
        'document' => $lease->nodeId,
        'generation' => 0,
        'lease_token' => $lease->token,
        'covered_from' => 0,
        'covered_through' => 1,
        'protocol' => 'yjs',
        'state_format' => 'yjs-update-v1',
        'schema_version' => 1,
        'type' => 'vaulter/rich-text',
        'expected_checkpoint_version' => $lease->checkpointVersion,
        'state' => base64_encode('u1'),
        'content' => Hub::tiptap('Over HTTP'),
    ];

    Hub::callV2('checkpoint', $body, token: null)
        ->assertOk()
        ->assertHeader('X-Vaulter-Collab-Protocol', '2')
        ->assertExactJson(['checkpoint_version' => Hub::aggregate($this->node)->state_version, 'marker_cleared' => true]);
    Hub::callV2('checkpoint', $body, token: null)
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_checkpoint_conflict')
        ->assertJsonPath('retryable', 'after_refetch');

    expect(Compaction::marker($this->node))->toBe([null, null])
        ->and(Compaction::seqs($this->node))->toBe([]);
});

it('binds publication to every leased binding component and preserves complete rows and events on loss', function (string $field, mixed $value): void {
    Compaction::append($this->node, 'accepted', seed: true);
    $lease = Compaction::leaseOf($this->node);
    $events = [];
    app('events')->listen(DocumentContentUpdated::class, function ($event) use (&$events): void {
        $events[] = $event;
    });
    $old = $lease->log->binding;
    $values = ['protocol' => $old->protocol, 'stateFormat' => $old->stateFormat, 'schemaVersion' => $old->schemaVersion, 'generation' => $old->generation];
    $values[$field] = $value;
    $foreign = new CollaborationStateBinding(...$values);
    $snapshot = static fn (): array => array_map(static fn (string $table) => DB::table($table)->get()->toJson(), ['v_nodes', 'v_documents', 'v_document_revisions', 'v_collaboration_heads', 'v_collaboration_updates', 'v_collaboration_receipts']);
    $before = $snapshot();
    expect(fn (): CheckpointResult => Compaction::publish($lease, overrides: ['binding' => $foreign]))->toThrow(CollaborationCheckpointConflictException::class);
    expect($snapshot())->toBe($before)->and($events)->toBe([]);
})->with(['protocol' => ['protocol', 'acme-ot'], 'format' => ['stateFormat', 'other-format'], 'schema' => ['schemaVersion', 2], 'generation' => ['generation', 9]]);

it('rejects re-labelling the leased document type even when a caller repeats the new current binding', function (): void {
    Compaction::append($this->node, 'accepted', seed: true);
    $lease = Compaction::leaseOf($this->node);
    app(VaulterDatabase::class)->write(fn () => Hub::aggregate($this->node)->forceFill(['type' => 'vaulter/markdown'])->save());
    $before = casState($this->node);
    expect(fn (): CheckpointResult => Compaction::publish($lease, overrides: ['documentType' => 'vaulter/markdown']))->toThrow(CollaborationCheckpointConflictException::class);
    expect(casState($this->node))->toEqual($before);
});
