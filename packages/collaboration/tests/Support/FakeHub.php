<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Support;

use Closure;
use Illuminate\Testing\TestResponse;
use Vaulter\Collaboration\Drain\BackoffDrainWaiter;
use Vaulter\Collaboration\Drain\DrainWaiter;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\PendingMarker;

/**
 * The hub's compaction worker as a {@see DrainWaiter} for tests: on the first poll of a drain it takes a lease over
 * HTTP (`compaction/lease`), merges each leased checkpoint with its tail by concatenating the payloads (PHP merges no
 * Yjs: the tests check coverage and CAS, not Yjs content) and publishes the result over HTTP (`checkpoint`); then the
 * real backoff polls the marker. Offline (`$online = false`) it does nothing and the drain runs into its deadline.
 *
 * Bind it with {@see self::install()}; the state is static because the container builds a new waiter per drain.
 */
final class FakeHub implements DrainWaiter
{
    public const string ID = 'fake-hub';

    public static bool $online = true;

    /** @var list<array{node: string, transactionLevel: int}> every drain the hub was asked to wait for */
    public static array $drains = [];

    /** @var list<array<string, mixed>> the leases the hub took */
    public static array $leases = [];

    /** @var list<array{status: int, body: array<string, mixed>}> the answers to its publications */
    public static array $published = [];

    public function __construct(private readonly VaulterDatabase $database, private readonly BackoffDrainWaiter $backoff) {}

    public static function install(bool $online = true): void
    {
        self::$online = $online;
        self::$drains = [];
        self::$leases = [];
        self::$published = [];
        app()->bind(DrainWaiter::class, self::class);
    }

    public function wait(PendingMarker $marker, Closure $settled, int $deadlineSeconds): bool
    {
        self::$drains[] = ['node' => $marker->nodeId, 'transactionLevel' => $this->database->connection()->transactionLevel()];
        $polled = false;

        return $this->backoff->wait($marker, static function () use (&$polled, $settled): bool {
            if (!$polled && self::$online) {
                self::compact();
            }
            $polled = true;

            return $settled();
        }, $deadlineSeconds);
    }

    /** One run of the compaction worker: lease what is due, merge and publish each. */
    public static function compact(int $max = 10): void
    {
        $leases = self::post('compaction/lease', ['hub_id' => self::ID, 'max' => $max])->assertOk()->json();
        foreach (is_array($leases) ? $leases : [] as $lease) {
            self::$leases[] = $lease;
            $state = base64_decode((string) ($lease['checkpoint'] ?? ''), true);
            foreach ($lease['tail'] as $update) {
                $state .= base64_decode($update['payload'], true);
            }
            $response = self::post('checkpoint', [
                'document' => $lease['document'],
                'generation' => $lease['generation'],
                'protocol' => $lease['protocol'],
                'state_format' => $lease['state_format'],
                'schema_version' => $lease['schema_version'],
                'type' => $lease['type'],
                'lease_token' => $lease['lease_token'],
                'covered_from' => $lease['checkpoint_seq'],
                'covered_through' => $lease['head_seq'],
                'expected_checkpoint_version' => $lease['checkpoint_version'],
                'state' => base64_encode($state === '' ? 'empty' : $state),
                'content' => Hub::tiptap('Compacted through '.$lease['head_seq']),
            ]);
            self::$published[] = ['status' => $response->status(), 'body' => (array) $response->json()];
        }
    }

    /** @param array<string, mixed> $body */
    public static function post(string $endpoint, array $body): TestResponse
    {
        return Hub::callV2($endpoint, $body, token: null);
    }
}
