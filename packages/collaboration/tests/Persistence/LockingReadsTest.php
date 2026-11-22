<?php

declare(strict_types=1);

use Illuminate\Database\Connection;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Database\Query\Builder;
use Illuminate\Database\Query\Grammars\MySqlGrammar;
use Illuminate\Database\Query\Grammars\SQLiteGrammar;
use Illuminate\Support\Str;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Drive\Models\Node;

/*
 * On MySQL (REPEATABLE READ) the transaction of an append or a load begins with a plain read (the node, in
 * CollaborativeState::lock()), which fixes its snapshot. Every read of the log and the document after the locks must be a
 * locking read, or it answers from that older snapshot: a load would report a head without its tail, and a retry of an
 * update id committed meanwhile would miss its receipt. On MySQL the statements are read as the server receives them;
 * SQLite and PostgreSQL render them through the MySQL grammar as they run.
 */

function lockingAppend(Node $node, string $payload, string $updateId, bool $seed = false): void
{
    app(UpdateLog::class)->append($node->getKey(), new UpdateEnvelope(
        generation: Hub::aggregate($node)->collab_epoch,
        updateId: $updateId,
        payload: $payload,
        claimedSha256: hash('sha256', $payload),
        origin: $seed ? 'server' : 'client',
        seedStateVersion: $seed ? Hub::aggregate($node)->state_version : null,
    ));
}

/**
 * The selects `$run` issues on the log tables and v_documents, as MySQL would receive them.
 *
 * @return array<string, list<string>> by entity
 */
function lockingSelects(Closure $run): array
{
    $connection = app(VaulterDatabase::class)->connection();
    if ($connection->getDriverName() === 'mysql') {
        // On MySQL itself the statements the server receives are the ones to check.
        $received = [];
        $connection->listen(static function (QueryExecuted $query) use (&$received): void {
            $received[] = $query->sql;
        });
        $run();

        return lockingSelectsByEntity(array_values(array_filter($received, static fn (string $sql): bool => str_starts_with($sql, 'select'))));
    }

    $recorder = new class($connection, new MySqlGrammar($connection)) extends SQLiteGrammar
    {
        /** @var list<string> */
        public array $selects = [];

        public function __construct(Connection $connection, private readonly MySqlGrammar $mysql)
        {
            parent::__construct($connection);
        }

        public function compileSelect(Builder $query)
        {
            $this->selects[] = $this->mysql->compileSelect($query);

            return parent::compileSelect($query);
        }
    };

    $connection->setQueryGrammar($recorder);
    try {
        $run();
    } finally {
        $connection->useDefaultQueryGrammar();
    }

    return lockingSelectsByEntity($recorder->selects);
}

/**
 * @param  list<string>                $selects MySQL selects
 * @return array<string, list<string>> by entity
 */
function lockingSelectsByEntity(array $selects): array
{
    $tables = app(DatabaseOptions::class);
    $byEntity = [];
    foreach (['documents', 'collaboration_heads', 'collaboration_updates', 'collaboration_receipts'] as $entity) {
        $from = 'from `'.$tables->table($entity).'`';
        $byEntity[$entity] = array_values(array_filter($selects, static fn (string $sql): bool => str_contains($sql, $from)));
    }

    return $byEntity;
}

beforeEach(function (): void {
    Hub::configure();
    $this->node = Hub::document();
});

it('reads the receipt of an appended update id with a locking read, on a first append and on a retry', function (): void {
    $id = (string) Str::uuid();

    $first = lockingSelects(fn () => lockingAppend($this->node, 'update', $id, seed: true));
    $retry = lockingSelects(fn () => lockingAppend($this->node, 'update', $id, seed: true));

    foreach ([$first, $retry] as $selects) {
        expect($selects['collaboration_receipts'])->toHaveCount(1)
            ->and($selects['collaboration_receipts'][0])->toEndWith('for update')
            ->and($selects['collaboration_heads'])->not->toBeEmpty()
            ->each->toEndWith('for update');
    }
});

it('reads the document row and the tail of a load with locking reads', function (): void {
    lockingAppend($this->node, 'first', (string) Str::uuid(), seed: true);
    lockingAppend($this->node, 'second', (string) Str::uuid());

    $snapshot = null;
    $selects = lockingSelects(function () use (&$snapshot): void {
        $snapshot = app(UpdateLog::class)->snapshot($this->node->getKey(), 0);
    });

    expect($snapshot->headSeq)->toBe(2)
        ->and($snapshot->tail)->toHaveCount(2)
        ->and($selects['documents'])->not->toBeEmpty()
        ->each->toEndWith('for update')
        ->and($selects['collaboration_heads'])->not->toBeEmpty()
        ->each->toEndWith('for update')
        ->and($selects['collaboration_updates'])->toHaveCount(1)
        ->and($selects['collaboration_updates'][0])->toEndWith('for update');
});
