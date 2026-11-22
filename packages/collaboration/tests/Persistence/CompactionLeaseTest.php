<?php

declare(strict_types=1);

use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Vaulter\Collaboration\Http\Controllers\Collaboration\HubCompactionLeaseController;
use Vaulter\Collaboration\Persistence\CompactionLease;
use Vaulter\Collaboration\Persistence\CompactionLeases;
use Vaulter\Collaboration\Persistence\LogTables;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Documents\State\PendingMarker;
use Vaulter\Drive\Models\Node;

/*
 * Scenario 19: the backend leases a document generation to the hub's compaction worker only while it is the
 * document's current one, open, and carries uncheckpointed edits that reached a trigger (500 updates, 1 MiB, 10 min by
 * default) or a drain request — drain requests first. A lease another hub holds is not handed out again before it
 * expires; a lease gives no right to append. The worker's calls carry the body signature, not a room token.
 */

/** @return list<string> the node ids one lease call hands out, in order */
function leasedNodes(string $hub = Compaction::HUB, int $max = 10): array
{
    return array_map(static fn (CompactionLease $lease): string => $lease->nodeId, Compaction::lease($hub, $max));
}

function requestDrain(Node $node): bool
{
    $document = Hub::aggregate($node);

    return app(CompactionLeases::class)->requestDrain(new PendingMarker(
        documentId: (string) $document->getKey(),
        nodeId: (string) $node->getKey(),
        binding: $document->collaborationBinding(),
        throughSeq: (int) $document->pending_through_seq,
    ));
}

beforeEach(function (): void {
    Hub::configure();
    $this->node = Hub::document();
});

it('leases nothing while no document has uncheckpointed edits', function (): void {
    expect(Compaction::lease())->toBe([])
        ->and(Compaction::rows('collaboration_heads'))->toBe(0);
});

it('leases a pending document only once its log reached the update trigger', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 3);
    Compaction::append($this->node, 'u1');
    Compaction::append($this->node, 'u2');
    expect(leasedNodes())->toBe([]);

    Compaction::append($this->node, 'u3');
    expect(leasedNodes())->toBe([(string) $this->node->getKey()]);
});

it('leases a pending document once its updates reach the byte trigger', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_bytes', 30);
    Compaction::append($this->node, str_repeat('a', 20));
    expect(leasedNodes())->toBe([]);

    Compaction::append($this->node, str_repeat('b', 20));
    expect(leasedNodes())->toBe([(string) $this->node->getKey()]);
});

it('leases a pending document once its oldest uncheckpointed update reaches the age trigger', function (): void {
    Compaction::append($this->node, 'u1');
    $this->travel(599)->seconds();
    expect(leasedNodes())->toBe([]);

    $this->travel(1)->seconds();
    expect(leasedNodes())->toBe([(string) $this->node->getKey()]);
});

it('leases a drained document below every trigger, ahead of the due ones', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 2);
    $due = Hub::document();
    Compaction::append($due, 'd1');
    Compaction::append($due, 'd2');
    Compaction::append($this->node, 'u1');

    expect(leasedNodes(max: 1))->toBe([(string) $due->getKey()]);
    $this->travel(61)->seconds();

    expect(requestDrain($this->node))->toBeTrue()
        ->and(Compaction::head($this->node)?->drainRequestedAt)->not->toBeNull()
        ->and(leasedNodes())->toBe([(string) $this->node->getKey(), (string) $due->getKey()]);
});

it('does not ask for a drain of a document without a marker', function (): void {
    expect(requestDrain($this->node))->toBeFalse()
        ->and(Compaction::rows('collaboration_heads'))->toBe(0);
});

it('hands out at most max leases', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $other = Hub::document();
    Compaction::append($this->node, 'u1');
    Compaction::append($other, 'o1');

    expect(Compaction::lease(max: 1))->toHaveCount(1)
        ->and(Compaction::lease(max: 1))->toHaveCount(1)
        ->and(Compaction::lease(max: 1))->toBe([]);
});

it('measures a generation before it reads its tail: the call ends before one that would pass max_state_bytes, a later call hands it out', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    // 12 stored bytes each (base64 of 9): both together pass the budget.
    config()->set('vaulter-collaboration.max_state_bytes', 20);
    $other = Hub::document();
    Compaction::append($this->node, str_repeat('a', 9));
    Compaction::append($other, str_repeat('b', 9));
    $tailReads = 0;
    DB::listen(static function (QueryExecuted $query) use (&$tailReads): void {
        if (preg_match('/^select\b.*\bupdate_id\b.*\bpayload\b.*collaboration_updates\b/i', $query->sql) === 1) {
            $tailReads++;
        }
    });

    $first = Compaction::lease();
    $skipped = $first[0]->nodeId === (string) $this->node->getKey() ? $other : $this->node;

    expect($first)->toHaveCount(1)
        ->and($first[0]->bytes())->toBe(12)
        ->and($tailReads)->toBe(1)
        ->and(Compaction::head($skipped)?->leaseToken)->toBeNull()
        ->and(leasedNodes())->toBe([(string) $skipped->getKey()]);
});

it('hands a first generation larger than the whole budget out alone', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    config()->set('vaulter-collaboration.max_state_bytes', 20);
    $other = Hub::document();
    Compaction::append($this->node, str_repeat('a', 30));
    Compaction::append($other, str_repeat('b', 30));

    expect(Compaction::lease())->toHaveCount(1)
        ->and(Compaction::lease())->toHaveCount(1)
        ->and(Compaction::lease())->toBe([]);
});

it('does not hand a held lease to another hub before it expires, then grants a new token', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    Compaction::append($this->node, 'u1');
    $first = Compaction::leaseOf($this->node, 'hub-a');

    expect(leasedNodes('hub-b'))->toBe([])
        ->and(leasedNodes('hub-a'))->toBe([])
        ->and(Compaction::head($this->node)?->leaseOwner)->toBe('hub-a');

    $this->travel(60)->seconds();
    $second = Compaction::leaseOf($this->node, 'hub-b');

    expect($second->token)->not->toBe($first->token)
        ->and(strlen($second->token))->toBe(64)
        ->and(Compaction::head($this->node)?->leaseOwner)->toBe('hub-b')
        ->and($second->expiresAt->greaterThan($first->expiresAt))->toBeTrue();
});

it('reads the checkpoint, the tail and the checkpoint version with the lease', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $one = Compaction::append($this->node, "\x00u1");
    Compaction::append($this->node, 'u2');
    $lease = Compaction::leaseOf($this->node);
    $document = Hub::aggregate($this->node);

    expect($lease->log->generation)->toBe(0)
        ->and($lease->log->checkpoint)->toBeNull()
        ->and([$lease->log->checkpointSeq, $lease->log->headSeq])->toBe([0, 2])
        ->and($lease->checkpointVersion)->toBe($document->state_version)
        ->and($lease->log->tail[0])->toBe(['seq' => 1, 'update_id' => $one->updateId, 'payload' => base64_encode("\x00u1")])
        ->and(Compaction::head($this->node)?->leaseExpiresAt?->equalTo($lease->expiresAt))->toBeTrue();
});

it('never leases a retired generation or one its document left', function (string $how): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    Compaction::append($this->node, 'u1');
    $heads = DB::table(app(DatabaseOptions::class)->table('collaboration_heads'));
    if ($how === 'retired') {
        $heads->update(['retired_at' => now()]);
    } else {
        // The generation moved on while the module was off: the head stayed open.
        Hub::aggregate($this->node)->forceFill(['collab_epoch' => 1, 'pending_generation' => null, 'pending_through_seq' => null, 'pending_protocol' => null, 'pending_state_format' => null, 'pending_schema_version' => null])->save();
    }
    $head = Compaction::head($this->node, 0);

    expect(Compaction::lease())->toBe([])
        ->and(Compaction::head($this->node, 0)?->leaseToken)->toBeNull()
        ->and($head?->generation)->toBe(0);
})->with(['retired' => ['retired'], 'left' => ['left']]);

it('leaves appends to the room: an append during a lease commits, and the lease covers only what it read', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    Compaction::append($this->node, 'u1');
    $lease = Compaction::leaseOf($this->node);

    $late = Compaction::append($this->node, 'u2');

    expect($late->seq)->toBe(2)
        ->and($lease->log->headSeq)->toBe(1)
        ->and(Compaction::marker($this->node))->toBe([0, 2]);
});

it('answers the worker over HTTP with the leases, signed but without a room token', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    Compaction::append($this->node, 'u1');

    $response = Hub::callV2('compaction/lease', ['hub_id' => 'hub-http', 'max' => 5], token: null)
        ->assertOk()
        ->assertHeader('X-Vaulter-Collab-Protocol', '2');

    $entry = $response->json('0');
    expect($response->json())->toHaveCount(1)
        ->and($entry['document'])->toBe((string) $this->node->getKey())
        ->and($entry['generation'])->toBe(0)
        ->and($entry['checkpoint_seq'])->toBe(0)
        ->and($entry['head_seq'])->toBe(1)
        ->and($entry['checkpoint_version'])->toBe(Hub::aggregate($this->node)->state_version)
        ->and($entry['type'])->toBe('vaulter/rich-text')
        ->and($entry['checkpoint'])->toBeNull()
        ->and($entry['content']['type'])->toBe('doc')
        ->and($entry['tail'][0]['payload'])->toBe(base64_encode('u1'))
        ->and($entry['lease_token'])->toBe(Compaction::head($this->node)?->leaseToken)
        ->and(Compaction::head($this->node)?->leaseOwner)->toBe('hub-http');
});

it('reports what is still due for compaction whichever hub holds its lease, until a checkpoint clears its marker', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 2);
    $id = (string) $this->node->getKey();
    $quiet = Hub::document();
    // Without report the answer is the list alone.
    Hub::callV2('compaction/lease', ['hub_id' => 'hub-b', 'max' => 5], token: null)
        ->assertOk()
        ->assertHeaderMissing(HubCompactionLeaseController::PENDING_HEADER);

    Compaction::append($this->node, 'u1');
    Compaction::append($this->node, 'u2');
    // Pending below every trigger: not due, not counted.
    Compaction::append($quiet, 'q1');
    $lease = Compaction::leaseOf($this->node, 'hub-a');

    // Another hub's lease hides it from the lease answer, not from the report.
    $response = Hub::callV2('compaction/lease', ['hub_id' => 'hub-b', 'max' => 5, 'report' => true], token: null)
        ->assertOk()
        ->assertHeader(HubCompactionLeaseController::PENDING_HEADER, '1')
        ->assertHeader(HubCompactionLeaseController::PENDING_DOCUMENTS_HEADER, $id.':0');
    expect($response->json())->toBe([]);

    expect(requestDrain($quiet))->toBeTrue();
    $both = app(CompactionLeases::class)->pending();
    expect($both['total'])->toBe(2)
        ->and(array_column($both['generations'], 'document'))->toEqualCanonicalizing([$id, (string) $quiet->getKey()])
        ->and(app(CompactionLeases::class)->pending(limit: 1)['generations'])->toHaveCount(1);

    expect(Compaction::publish($lease)->markerCleared)->toBeTrue()
        ->and(app(CompactionLeases::class)->pending())->toBe(['total' => 1, 'generations' => [['document' => (string) $quiet->getKey(), 'generation' => 0]]]);
});

it('refuses a worker call without protocol 2, without a valid signature, or with a malformed body', function (): void {
    Hub::callV2('compaction/lease', ['hub_id' => 'hub'], token: null, protocol: null)
        ->assertStatus(409)
        ->assertJsonPath('code', 'collaboration_protocol_mismatch');

    $body = ['hub_id' => 'hub', 'nonce' => 'n1'];
    $this->postJson('api/vaulter/v1/collaboration/hub/compaction/lease', $body, ['X-Vaulter-Collab-Protocol' => '2'])->assertStatus(401);
    $this->postJson('api/vaulter/v1/collaboration/hub/compaction/lease', $body, [...Hub::headers($body, null, secret: 'not-the-secret'), 'X-Vaulter-Collab-Protocol' => '2'])->assertStatus(401);
    $this->postJson('api/vaulter/v1/collaboration/hub/checkpoint', $body, ['X-Vaulter-Collab-Protocol' => '2'])->assertStatus(401);

    Hub::callV2('compaction/lease', [], token: null)->assertStatus(422)->assertJsonPath('code', 'validation_failed');
    Hub::callV2('compaction/lease', ['hub_id' => 'hub', 'max' => 0], token: null)->assertStatus(422);
    Hub::callV2('compaction/lease', ['hub_id' => 'hub', 'max' => CompactionLeases::MAX + 1], token: null)->assertStatus(422);
    Hub::callV2('compaction/lease', ['hub_id' => 'hub', 'max' => 1, 'report' => 'yes'], token: null)->assertStatus(422);
    Hub::callV2('checkpoint', ['document' => '1'], token: null)->assertStatus(422);
});

it('gives the worker no right to append: a signed append without a room token is refused', function (): void {
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    Compaction::append($this->node, 'u1');
    Compaction::leaseOf($this->node);

    Hub::callV2('append', Hub::appendBody($this->node, 'from the worker'), token: null)->assertStatus(401);

    expect(Compaction::seqs($this->node))->toBe([1]);
});

it('refuses a checkpoint body above the checkpoint limit by its Content-Length', function (): void {
    config()->set('vaulter-collaboration.max_state_bytes', 3);
    config()->set('vaulter-collaboration.limits.request_bytes', 100);
    $body = ['document' => '1', 'state' => str_repeat('A', 200)];

    Hub::callV2('checkpoint', $body, token: null)
        ->assertStatus(413)
        ->assertJsonPath('code', 'collaboration_update_too_large');
    expect(app(LogTables::class)->table('collaboration_heads')->count())->toBe(0);
});
