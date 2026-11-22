<?php

declare(strict_types=1);

use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Sleep;
use Vaulter\Collaboration\Drain\DrainState;
use Vaulter\Collaboration\Drain\PendingDocuments;
use Vaulter\Collaboration\Drain\PendingRemovalGuard;
use Vaulter\Collaboration\Exceptions\CollaborationDrainingException;
use Vaulter\Collaboration\Persistence\AppendResult;
use Vaulter\Collaboration\Persistence\CompactionLeases;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Collaboration\Tests\Support\DocumentsV1 as Docs;
use Vaulter\Collaboration\Tests\Support\FakeHub;
use Vaulter\Documents\State\PendingMarker;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;

/*
 * Scenario 12, managed disable: vaulter:collaboration:drain sets the draining flag — from then on every append is
 * refused with 503 collaboration_draining — asks the hub to checkpoint every document with a pending marker, and waits
 * outside any transaction until none carries one or the deadline passed. It decides on what pendingDocuments() reads,
 * never on the hub's answers, and never earlier than drain.max_append_tx (5 s) after it set the flag: an append that
 * read the flag just before has committed by then, and its marker is drained too. The flag stays until --release.
 *
 * The fake hub (tests/Support/FakeHub.php) leases and publishes over HTTP on the first poll of a wait; its merge
 * concatenates the payloads. Offline it does nothing and the drain runs into its deadline. Time is Sleep::fake's.
 */

/** The output line of a pending document, as the drain lists it. */
function drainListed(Node $node): string
{
    return 'document_id '.Hub::aggregate($node)->getKey().' (node '.$node->getKey().',';
}

/** An append that read the flag before vaulter:collaboration:drain set it and commits now, inside the drain's window. */
function drainLateAppend(Node $node, string $payload): void
{
    $store = Cache::store();
    $since = $store->get(DrainState::KEY);
    $store->forget(DrainState::KEY);
    try {
        Compaction::append($node, $payload, seed: true);
    } finally {
        $store->forever(DrainState::KEY, $since);
    }
}

beforeEach(function (): void {
    Hub::configure();
    Sleep::fake(syncWithCarbon: true);
    $this->first = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
    $this->second = Hub::document(level: RoleRegistry::WRITER, actorId: 1);
});

it('checkpoints every pending document through the hub and exits 0: no marker, every saved edit in the working state', function (): void {
    FakeHub::install();
    Compaction::append($this->first, 'a1', seed: true);
    Compaction::append($this->first, 'a2');
    Compaction::append($this->second, 'b1', seed: true);
    $started = Carbon::now();

    $this->artisan('vaulter:collaboration:drain')
        ->expectsOutputToContain('No document is pending')
        ->assertExitCode(0);

    expect(Compaction::marker($this->first))->toBe([null, null])
        ->and(Compaction::marker($this->second))->toBe([null, null])
        ->and(FakeHub::$drains)->each->toMatchArray(['transactionLevel' => 0])
        ->and(array_column(FakeHub::$published, 'status'))->toBe([200, 200])
        // The checkpoint covers every saved receipt; the receipts stay, the covered updates go.
        ->and(Hub::aggregate($this->first)->collab_state)->toBe('a1a2')
        ->and(Hub::aggregate($this->second)->collab_state)->toBe('b1')
        ->and(Compaction::head($this->first)?->checkpointSeq)->toBe(2)
        ->and(Compaction::head($this->first)?->drainRequestedAt)->toBeNull()
        ->and(Compaction::rows('collaboration_receipts'))->toBe(3)
        ->and(Compaction::rows('collaboration_updates'))->toBe(0)
        // Not before an append that missed the flag could have committed.
        ->and($started->diffInSeconds(Carbon::now()))->toBeGreaterThanOrEqual(5.0)
        ->and(app(DrainState::class)->since())->not->toBeNull();

    $this->actingAs(AccessTestHelpers::user(1));
    $this->getJson(Docs::url('documents/'.$this->first->getKey().'/content'))
        ->assertOk()
        ->assertJsonPath('data.content.content.0.content.0.text', 'Compacted through 2');
});

it('exits 1 and lists every pending document when the hub does not answer; the markers, receipts and updates stay', function (): void {
    FakeHub::install(online: false);
    Compaction::append($this->first, 'a1', seed: true);
    Compaction::append($this->second, 'b1', seed: true);
    $started = Carbon::now();

    $this->artisan('vaulter:collaboration:drain', ['--deadline' => 2])
        ->expectsOutputToContain(drainListed($this->first))
        ->expectsOutputToContain(drainListed($this->second))
        ->expectsOutputToContain('2 document(s) still have saved collaboration edits')
        ->assertExitCode(1);

    expect(Compaction::marker($this->first))->toBe([0, 1])
        ->and(Compaction::marker($this->second))->toBe([0, 1])
        ->and(Compaction::rows('collaboration_receipts'))->toBe(2)
        ->and(Compaction::rows('collaboration_updates'))->toBe(2)
        ->and(Compaction::head($this->first)?->drainRequestedAt)->not->toBeNull()
        ->and(Compaction::head($this->second)?->drainRequestedAt)->not->toBeNull()
        // The deadline was shorter than the append window: the outcome waited for the window.
        ->and($started->diffInSeconds(Carbon::now()))->toBeGreaterThanOrEqual(5.0);
});

it('refuses every append while the flag is set, over HTTP and on the service, and accepts them again after --release', function (): void {
    FakeHub::install();
    $token = Hub::token($this->first);

    $this->artisan('vaulter:collaboration:drain')->assertExitCode(0);

    Hub::callV2('append', Hub::appendBody($this->first, 'refused'), $token)
        ->assertStatus(503)
        ->assertJsonPath('code', 'collaboration_draining')
        ->assertJsonPath('retryable', 'with_backoff');
    expect(fn (): AppendResult => Compaction::append($this->second, 'refused'))->toThrow(CollaborationDrainingException::class)
        ->and(Compaction::rows('collaboration_updates'))->toBe(0)
        ->and(Compaction::rows('collaboration_heads'))->toBe(0)
        ->and(Compaction::marker($this->first))->toBe([null, null]);

    $this->artisan('vaulter:collaboration:drain', ['--release' => true])
        ->expectsOutputToContain('accepts updates again')
        ->assertExitCode(0);

    Hub::callV2('append', Hub::seedBody($this->first, 'accepted'), $token)
        ->assertOk()
        ->assertJsonPath('persisted', true);
    expect(app(DrainState::class)->since())->toBeNull();
    $this->artisan('vaulter:collaboration:drain', ['--release' => true])
        ->expectsOutputToContain('was not draining')
        ->assertExitCode(0);
});

it('drains the marker of an append that missed the flag and committed within the window, and only then exits 0', function (): void {
    FakeHub::install();
    $late = false;
    Sleep::whenFakingSleep(function () use (&$late): void {
        if (!$late) {
            $late = true;
            drainLateAppend($this->first, 'late');
        }
    });

    $this->artisan('vaulter:collaboration:drain')
        ->expectsOutputToContain('No document is pending')
        ->assertExitCode(0);

    expect($late)->toBeTrue()
        ->and(Compaction::marker($this->first))->toBe([null, null])
        ->and(Hub::aggregate($this->first)->collab_state)->toBe('late')
        ->and(FakeHub::$drains)->toHaveCount(1);
});

it('never reports success while such a late marker remains: exit 1 with the document when the hub is offline', function (): void {
    FakeHub::install(online: false);
    $late = false;
    Sleep::whenFakingSleep(function () use (&$late): void {
        if (!$late) {
            $late = true;
            drainLateAppend($this->second, 'late');
        }
    });

    $this->artisan('vaulter:collaboration:drain', ['--deadline' => 3])
        ->expectsOutputToContain(drainListed($this->second))
        ->expectsOutputToContain('1 document(s) still have saved collaboration edits')
        ->assertExitCode(1);

    expect(Compaction::marker($this->second))->toBe([0, 1])
        ->and(Compaction::marker($this->first))->toBe([null, null]);
});

it('rolls back an append the flag reached inside its transaction: it reads the flag again before the commit, nothing is written', function (): void {
    Compaction::append($this->first, 'saved', seed: true);
    // The drain sets the flag after this append read it and wrote its update, before it commits.
    DB::listen(static function (QueryExecuted $query): void {
        if (str_starts_with($query->sql, 'insert') && str_contains($query->sql, 'collaboration_updates') && !Cache::store()->has(DrainState::KEY)) {
            Cache::store()->forever(DrainState::KEY, Carbon::now()->getTimestampMs());
        }
    });

    expect(fn (): AppendResult => Compaction::append($this->first, 'late'))->toThrow(CollaborationDrainingException::class)
        ->and(Compaction::seqs($this->first))->toBe([1])
        ->and(Compaction::rows('collaboration_receipts'))->toBe(1)
        ->and(Compaction::head($this->first)?->headSeq)->toBe(1)
        ->and(Compaction::marker($this->first))->toBe([0, 1]);
});

it('exits 1 and asks the hub for nothing when the cache store does not keep the flag: appends are still accepted', function (): void {
    FakeHub::install();
    config()->set('cache.stores.drain-dropped', ['driver' => 'null']);
    config()->set('vaulter-collaboration.drain.cache_store', 'drain-dropped');
    Compaction::append($this->first, 'a1', seed: true);

    $this->artisan('vaulter:collaboration:drain')
        ->expectsOutputToContain('did not keep the draining flag')
        ->assertExitCode(1);

    expect(FakeHub::$drains)->toBe([])
        ->and(Compaction::head($this->first)?->drainRequestedAt)->toBeNull()
        ->and(Compaction::append($this->first, 'a2')->seq)->toBe(2);
});

it('keeps the moment of the first drain when it is repeated', function (): void {
    FakeHub::install();
    $this->artisan('vaulter:collaboration:drain')->assertExitCode(0);
    $since = app(DrainState::class)->since();

    $this->artisan('vaulter:collaboration:drain', ['--deadline' => 1])->assertExitCode(0);

    expect(app(DrainState::class)->since()?->getTimestampMs())->toBe($since?->getTimestampMs());
});

it('refuses a deadline that is not a whole number of seconds', function (string $deadline): void {
    $this->artisan('vaulter:collaboration:drain', ['--deadline' => $deadline])
        ->expectsOutputToContain('--deadline takes a whole number of seconds')
        ->assertExitCode(2);

    expect(app(DrainState::class)->since())->toBeNull();
})->with(['0', '-5', 'soon', '1.5']);

it('drains and allows Yjs removal while both pending scanners preserve unrelated Acme markers', function (): void {
    $acme = Hub::aggregate($this->second);
    $acme->forceFill(['collab_protocol' => 'acme-ot', 'collab_state_format' => 'acme-json-v1', 'pending_protocol' => 'acme-ot', 'pending_state_format' => 'acme-json-v1', 'pending_schema_version' => 1, 'pending_generation' => 0, 'pending_through_seq' => 1])->save();
    DB::table('v_collaboration_heads')->insert(['document_id' => $acme->getKey(), 'generation' => 0, 'head_seq' => 1, 'checkpoint_seq' => 0, 'checkpoint_version' => $acme->state_version, 'created_at' => now(), 'updated_at' => now()]);
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    $before = $acme->getAttributes();
    Hub::callV2('append', Hub::seedBody($this->first, 'saved-yjs'), Hub::token($this->first))->assertOk();
    expect(array_map(static fn (PendingMarker $m): string => $m->nodeId, app(PendingDocuments::class)->all()))->toBe([(string) $this->first->getKey()]);
    expect(app(CompactionLeases::class)->pending()['total'])->toBe(1);
    FakeHub::install();
    $this->artisan('vaulter:collaboration:drain')->assertExitCode(0);
    expect(app(PendingRemovalGuard::class)->blockers('collaboration'))->toBe([])
        ->and(Hub::aggregate($this->second)->getAttributes())->toBe($before)
        ->and(Compaction::marker($this->first))->toBe([null, null]);
});

it('drains Markdown ACKed history through the hub with null and non-null initial checkpoint', function (bool $checkpoint): void {
    $node = Hub::document(type: 'vaulter/markdown');
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    Compaction::append($node, 'markdown-seed', seed: true);
    if ($checkpoint) {
        Compaction::publish(Compaction::leaseOf($node));
        Compaction::append($node, 'tail');
    }
    FakeHub::install();
    $this->artisan('vaulter:collaboration:drain')->assertExitCode(0);
    expect(Compaction::marker($node))->toBe([null, null])->and(Hub::aggregate($node)->collab_state)->toBe($checkpoint ? 'markdown-seedtail' : 'markdown-seed');
})->with(['null checkpoint' => [false], 'non-null checkpoint' => [true]]);
