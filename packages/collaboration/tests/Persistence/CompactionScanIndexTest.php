<?php

declare(strict_types=1);

use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Compaction;

/*
 * Every lease call of every hub scans the heads twice, for drain requests and for uncheckpointed generations. On
 * PostgreSQL and SQLite each scan reads a partial index of the heads it selects, so its cost follows the work due and
 * not the number of open heads. MySQL and MariaDB have no partial indexes and keep scanning the primary key.
 */

/** @return list<QueryExecuted> the head scans of one lease call */
function headScans(): array
{
    $scans = [];
    DB::listen(static function (QueryExecuted $query) use (&$scans): void {
        if (str_contains($query->sql, 'collaboration_heads') && str_contains($query->sql, 'order by')) {
            $scans[] = $query;
        }
    });
    Compaction::lease();

    return $scans;
}

/** The plan of `$query` as one string. */
function scanPlan(QueryExecuted $query): string
{
    $db = DB::connection($query->connectionName);
    if ($db->getDriverName() === 'sqlite') {
        return implode("\n", array_map(static fn (object $row): string => (string) $row->detail, $db->select('EXPLAIN QUERY PLAN '.$query->sql, $query->bindings)));
    }

    // An empty table is cheapest to read whole; the planner must show which index it can use instead.
    return $db->transaction(static function () use ($db, $query): string {
        $db->statement('SET LOCAL enable_seqscan = off');

        return implode("\n", array_map(static fn (object $row): string => (string) $row->{'QUERY PLAN'}, $db->select('EXPLAIN '.$query->sql, $query->bindings)));
    });
}

it('reads the drain and the pending scan of a lease call through their partial indexes', function (): void {
    Hub::configure();
    config()->set('vaulter-collaboration.compaction.trigger_updates', 1);
    Compaction::append(Hub::document(), 'u1');

    $scans = headScans();
    expect($scans)->toHaveCount(2);

    $driver = DB::connection($scans[0]->connectionName)->getDriverName();
    if (!in_array($driver, ['pgsql', 'sqlite'], true)) {
        return;
    }
    expect(scanPlan($scans[0]))->toContain('collaboration_heads_drain_scan')
        ->and(scanPlan($scans[1]))->toContain('collaboration_heads_pending_scan');
});
