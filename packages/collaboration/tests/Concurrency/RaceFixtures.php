<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Concurrency;

use Closure;
use Illuminate\Support\Facades\Event;
use Throwable;
use Vaulter\Collaboration\Tests\Support\DocumentTestHelpers;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Actions\Documents\CreateDocumentAction;
use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Documents\Events\Documents\DocumentContentUpdated;
use Vaulter\Documents\Events\Revisions\DocumentRestored;
use Vaulter\Documents\Events\Revisions\DocumentRevisionCreated;
use Vaulter\Drive\Events\Nodes\NodeRenamed;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Exceptions\Contracts\ProblemException;
use Vaulter\Testing\Concurrency\ForkRace;
use Vaulter\Testing\Concurrency\RaceOutcome;

/**
 * Shared pieces of the PostgreSQL race scenarios of the collaboration store: a committed
 * fixture the forked backends can see, one racing attempt that reports what happened to
 * it, and the fork runner that proves the contenders ran on separate backends.
 */
final class RaceFixtures
{
    /** A committed document; $sequence lets a scenario start the node validator above zero. */
    public static function document(int $sequence = 0): Node
    {
        $drive = DocumentTestHelpers::drive();
        $node = app(CreateDocumentAction::class)->execute(DocumentTestHelpers::context($drive->model()), new CreateDocumentInput(
            storage: $drive->model(),
            name: 'Race document',
            content: DocumentTestHelpers::content('initial'),
            parent: DriveTestHelpers::model($drive->root()),
        ));
        if ($sequence !== 0) {
            app(VaulterDatabase::class)->write(fn () => Node::query()->whereKey($node->getKey())->update(['sequence' => $sequence]));
        }

        return $node->refresh();
    }

    /**
     * One contender: what it did (committed or the problem code it was refused with), on
     * which backend, and how many document or node events it raised.
     *
     * @return array{kind: string, pid: int, events: int, status: ?int}
     */
    public static function attempt(Closure $write): array
    {
        $pid = (int) app(VaulterDatabase::class)->connection()->selectOne('select pg_backend_pid() as pid')->pid;
        $events = 0;
        Event::listen([DocumentContentUpdated::class, DocumentRevisionCreated::class, DocumentRestored::class, NodeRenamed::class], static function () use (&$events): void {
            $events++;
        });

        try {
            $write();

            return ['kind' => 'committed', 'pid' => $pid, 'events' => $events, 'status' => null];
        } catch (ProblemException $exception) {
            return ['kind' => $exception->problemCode(), 'pid' => $pid, 'events' => $events, 'status' => $exception->httpStatus()];
        } catch (Throwable $exception) {
            return ['kind' => $exception::class, 'pid' => $pid, 'events' => $events, 'status' => null];
        }
    }

    /**
     * @param  list<Closure(): array{kind: string, pid: int, events: int, status: ?int}> $tasks
     * @return list<array{kind: string, pid: int, events: int, status: ?int}>
     */
    public static function race(array $tasks): array
    {
        $outcomes = ForkRace::run($tasks, connections: [app(VaulterDatabase::class)->connection()->getName()]);

        foreach ($outcomes as $outcome) {
            expect($outcome->ok)->toBeTrue($outcome->message ?? '');
        }
        $results = array_map(static fn (RaceOutcome $outcome): array => $outcome->value, $outcomes);
        expect(count(array_unique(array_column($results, 'pid'))))->toBe(count($tasks));

        return $results;
    }
}
