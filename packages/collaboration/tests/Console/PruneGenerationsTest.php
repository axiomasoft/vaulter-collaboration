<?php

declare(strict_types=1);

use Illuminate\Console\Scheduling\Event;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Support\Facades\DB;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Drive\Models\Node;

/*
 * vaulter:collaboration:prune: deletes the updates, receipts and head of the generations closed longer ago than
 * token_ttl + the retry horizon + retention.retired_generation_days, never the document's current generation. It first
 * retires the open heads of generations a document already left (closed while the module was off), whose grace starts
 * then. --dry-run counts and deletes nothing. The scheduler runs it daily.
 */

/** Closes generation 0 of `$node` the way a restore with the module on does, with one update and its receipt. */
function pruneClosed(Node $node): void
{
    Compaction::append($node, 'u1');
    DB::table(app(DatabaseOptions::class)->table('collaboration_heads'))
        ->where('document_id', Hub::aggregate($node)->getKey())
        ->update(['retired_at' => now()]);
    Hub::aggregate($node)->forceFill(['collab_epoch' => 1, 'pending_generation' => null, 'pending_through_seq' => null, 'pending_protocol' => null, 'pending_state_format' => null, 'pending_schema_version' => null])->save();
}

function pruneGrace(): int
{
    return app(CollaborationOptions::class)->retiredGenerationGraceSeconds();
}

/** @return array<string, Event> */
function pruneTasks(array $config = []): array
{
    config($config);
    app()->forgetInstance(Schedule::class);

    $tasks = [];
    foreach (app(Schedule::class)->events() as $event) {
        if (str_starts_with((string) $event->description, 'vaulter:collaboration:')) {
            $tasks[$event->description] = $event;
        }
    }

    return $tasks;
}

beforeEach(function (): void {
    Hub::configure();
    $this->node = Hub::document();
});

it('prunes a closed generation past its grace and keeps one within it', function (): void {
    pruneClosed($this->node);
    $other = Hub::document();
    $this->travel(pruneGrace() - 60)->seconds();
    pruneClosed($other);

    $this->travel(61)->seconds();
    $this->artisan('vaulter:collaboration:prune')
        ->expectsOutputToContain('pruned 1 closed generation')
        ->assertExitCode(0);

    expect(Compaction::head($this->node, 0))->toBeNull()
        ->and(Compaction::head($other, 0))->not->toBeNull()
        ->and(Compaction::rows('collaboration_receipts'))->toBe(1)
        ->and(Compaction::rows('collaboration_updates'))->toBe(1);
});

it('counts what it would prune with --dry-run and deletes nothing', function (): void {
    pruneClosed($this->node);
    $this->travel(pruneGrace() + 1)->seconds();

    $this->artisan('vaulter:collaboration:prune', ['--dry-run' => true])
        ->expectsOutputToContain('Would prune 1 closed generation')
        ->assertExitCode(0);

    expect(Compaction::rows('collaboration_heads'))->toBe(1)
        ->and(Compaction::rows('collaboration_receipts'))->toBe(1);
});

it('retires the open head of a generation its document left, and prunes it only after the grace from then', function (): void {
    Compaction::append($this->node, 'u1');
    // The generation moved on while the module was off: no sink closed the head.
    Hub::aggregate($this->node)->forceFill(['collab_epoch' => 1, 'pending_generation' => null, 'pending_through_seq' => null, 'pending_protocol' => null, 'pending_state_format' => null, 'pending_schema_version' => null])->save();
    $this->travel(400)->days();

    $this->artisan('vaulter:collaboration:prune')->expectsOutputToContain('Retired 1 left generation')->assertExitCode(0);
    expect(Compaction::head($this->node, 0)?->retiredAt?->equalTo(now()->startOfSecond()))->toBeTrue()
        ->and(Compaction::rows('collaboration_receipts'))->toBe(1);

    $this->travel(pruneGrace() + 1)->seconds();
    $this->artisan('vaulter:collaboration:prune')->assertExitCode(0);
    expect(Compaction::rows('collaboration_heads'))->toBe(0)
        ->and(Compaction::rows('collaboration_receipts'))->toBe(0);
});

it('never retires or prunes the document\'s current generation', function (): void {
    Compaction::append($this->node, 'u1');
    $this->travel(400)->days();

    $this->artisan('vaulter:collaboration:prune')->assertExitCode(0);

    expect(Compaction::head($this->node, 0)?->retiredAt)->toBeNull()
        ->and(Compaction::rows('collaboration_updates'))->toBe(1)
        ->and(Compaction::append($this->node, 'u2')->seq)->toBe(2);
});

it('schedules the prune daily with overlap and single-server guards, and a null frequency turns it off', function (): void {
    $tasks = pruneTasks();

    expect(array_keys($tasks))->toBe(['vaulter:collaboration:prune'])
        ->and($tasks['vaulter:collaboration:prune']->expression)->toBe('40 3 * * *')
        ->and($tasks['vaulter:collaboration:prune']->withoutOverlapping)->toBeTrue()
        ->and($tasks['vaulter:collaboration:prune']->onOneServer)->toBeTrue()
        ->and(pruneTasks(['vaulter-collaboration.schedule.collaboration_prune' => null]))->toBe([]);
});
