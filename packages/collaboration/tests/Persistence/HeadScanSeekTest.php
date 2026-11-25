<?php

declare(strict_types=1);

use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;
use Vaulter\Collaboration\Persistence\LogTables;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Support\Identity;

it('reads every head exactly once, each page after the first seeking from its cursor', function (): void {
    Hub::configure();
    $log = app(LogTables::class);
    $expected = [];
    // More generations per document than a page holds, so a page boundary falls inside one document.
    foreach ([Hub::document(), Hub::document(), Hub::document()] as $node) {
        $document = Identity::key((string) Hub::aggregate($node)->getKey());
        $rows = [];
        foreach (range(1, 120) as $generation) {
            $rows[] = ['document_id' => $document, 'generation' => $generation, 'protocol' => 'yjs/2', 'profile' => 'standard',
                'head_seq' => 0, 'checkpoint_seq' => 0, 'checkpoint_version' => 1, 'created_at' => now(), 'updated_at' => now()];
            $expected[] = Identity::stringify($document).':'.$generation;
        }
        $log->table('collaboration_heads')->insert($rows);
    }
    $pages = [];
    DB::listen(static function (QueryExecuted $query) use (&$pages): void {
        if (str_contains($query->sql, 'collaboration_heads') && str_contains($query->sql, 'order by')) {
            $pages[] = $query->sql;
        }
    });

    $seen = [];
    foreach ($log->scan(static fn (Builder $query): Builder => $query) as $head) {
        $seen[] = $head->documentId.':'.$head->generation;
    }
    sort($seen);
    sort($expected);

    $bound = DB::connection()->getQueryGrammar()->wrap('document_id').' >= ?';
    expect($seen)->toBe($expected)
        ->and($pages)->toHaveCount(4)
        ->and($pages[0])->not->toContain($bound)
        ->and(array_slice($pages, 1))->each->toContain($bound);
});
