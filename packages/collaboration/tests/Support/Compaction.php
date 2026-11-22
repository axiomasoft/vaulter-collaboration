<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Support;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use LogicException;
use Vaulter\Collaboration\Persistence\AppendResult;
use Vaulter\Collaboration\Persistence\Checkpoint;
use Vaulter\Collaboration\Persistence\CheckpointRequest;
use Vaulter\Collaboration\Persistence\CheckpointResult;
use Vaulter\Collaboration\Persistence\CompactionLease;
use Vaulter\Collaboration\Persistence\CompactionLeases;
use Vaulter\Collaboration\Persistence\Head;
use Vaulter\Collaboration\Persistence\LogTables;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Drive\Models\Node;

/**
 * The hub's compaction worker for tests, on the services: append updates, take a lease, merge the checkpoint and the
 * tail the lease read — by concatenating the payloads, PHP merges no Yjs and the tests check coverage and CAS, not Yjs
 * content — and publish. Plus readers of the log tables.
 */
final class Compaction
{
    public const string HUB = 'hub-a';

    /**
     * The first record of an empty, unseeded generation is its seed (origin server, CAS on the state version the load
     * returned): the log accepts nothing else there. Every later record is a client update.
     */
    public static function append(Node $node, string $payload, ?int $generation = null, ?string $updateId = null, bool $seed = false): AppendResult
    {
        $aggregate = Hub::aggregate($node);
        $generation ??= $aggregate->collab_epoch;
        $seed = $seed || ($generation === $aggregate->collab_epoch && $aggregate->collab_state_size === null && (self::head($node, $generation)?->headSeq ?? 0) === 0);

        return app(UpdateLog::class)->append($node->getKey(), new UpdateEnvelope(
            generation: $generation,
            updateId: $updateId ?? (string) Str::uuid(),
            payload: $payload,
            claimedSha256: hash('sha256', $payload),
            origin: $seed ? 'server' : 'client',
            seedStateVersion: $seed ? $aggregate->state_version : null,
        ));
    }

    /** @return list<CompactionLease> */
    public static function lease(string $hub = self::HUB, int $max = 10): array
    {
        return app(CompactionLeases::class)->grant($hub, $max);
    }

    /** The lease on `$node` from one lease call; fails when the call did not lease it. */
    public static function leaseOf(Node $node, string $hub = self::HUB): CompactionLease
    {
        foreach (self::lease($hub) as $lease) {
            if ($lease->nodeId === (string) $node->getKey()) {
                return $lease;
            }
        }

        throw new LogicException('The document was not leased.');
    }

    /** The checkpoint the lease read with its tail through `$through` (all of it by default) applied. */
    public static function merged(CompactionLease $lease, ?int $through = null): string
    {
        $state = $lease->log->checkpoint ?? '';
        foreach ($lease->log->tail as $update) {
            if ($update['seq'] <= ($through ?? $lease->log->headSeq)) {
                $state .= base64_decode($update['payload'], true);
            }
        }

        return $state === '' ? 'empty' : $state;
    }

    /** @param array<string, mixed> $overrides named arguments of the CheckpointRequest */
    public static function request(CompactionLease $lease, ?int $through = null, array $overrides = []): CheckpointRequest
    {
        $through ??= $lease->log->headSeq;

        return new CheckpointRequest(...[
            'nodeId' => $lease->nodeId,
            'generation' => $lease->log->generation,
            'leaseToken' => $lease->token,
            'coveredFrom' => $lease->log->checkpointSeq,
            'coveredThrough' => $through,
            'expectedCheckpointVersion' => $lease->checkpointVersion,
            'state' => self::merged($lease, $through),
            'content' => Hub::tiptap('Compacted through '.$through),
            'binding' => $lease->log->binding,
            'documentType' => $lease->log->type,
            ...$overrides,
        ]);
    }

    /** @param array<string, mixed> $overrides */
    public static function publish(CompactionLease $lease, ?int $through = null, array $overrides = []): CheckpointResult
    {
        return app(Checkpoint::class)->publish(self::request($lease, $through, $overrides));
    }

    public static function rows(string $entity): int
    {
        return DB::table(app(DatabaseOptions::class)->table($entity))->count();
    }

    /** @return list<int> the seqs of the updates still in the log of the document's generation */
    public static function seqs(Node $node, ?int $generation = null): array
    {
        $rows = app(LogTables::class)->rows('collaboration_updates', (string) Hub::aggregate($node)->getKey(), $generation ?? Hub::aggregate($node)->collab_epoch);

        return array_map(static fn (mixed $seq): int => (int) $seq, $rows->orderBy('seq')->pluck('seq')->all());
    }

    public static function head(Node $node, ?int $generation = null): ?Head
    {
        $tables = app(LogTables::class);
        $heads = $tables->heads($tables->rows('collaboration_heads', (string) Hub::aggregate($node)->getKey(), $generation ?? Hub::aggregate($node)->collab_epoch));

        return $heads[0] ?? null;
    }

    /** @return array{int|null, int|null} the pending marker of the document */
    public static function marker(Node $node): array
    {
        $document = Hub::aggregate($node);

        return [$document->pending_generation, $document->pending_through_seq];
    }
}
