<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Closure;
use Generator;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Carbon;
use LogicException;
use Packman\Attributes\Internal;
use stdClass;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Support\Identity;

/**
 * The update log tables for the paths beside the append (UpdateLog): the compaction lease, the checkpoint publication,
 * the drain request, the closing and the prune of a generation. Each of them takes CollaborativeState::lock()
 * (T → N → D) first and the head row after it, never the other way round.
 */
#[Internal]
final readonly class LogTables
{
    /** The head rows a scan reads per query. */
    private const int PAGE = 100;

    /** The head columns a {@see Head} is read from. */
    private const array HEAD_COLUMNS = [
        'document_id', 'generation', 'protocol', 'head_seq', 'checkpoint_seq', 'checkpoint_version',
        'lease_token', 'lease_owner', 'lease_expires_at', 'lease_through_seq', 'drain_requested_at', 'retired_at',
        'profile', 'owner_fence', 'owner_id', 'owner_expires_at',
        'tail_bytes', 'tail_wire_bytes', 'tail_oldest_at', 'tail_latest_at',
    ];

    public function __construct(
        private VaulterDatabase $database,
        private DatabaseOptions $tables,
    ) {}

    public function table(string $entity): Builder
    {
        return $this->database->connection()->table($this->tables->table($entity));
    }

    /** The rows of one document generation in `$entity` (heads, updates or receipts). */
    public function rows(string $entity, string $documentId, int $generation): Builder
    {
        return $this->table($entity)
            ->where('document_id', Identity::key($documentId))
            ->where('generation', $generation);
    }

    /**
     * Summarize the surviving tail after a checkpoint, under the document and head locks.
     *
     * @return array{tail_bytes: int, tail_wire_bytes: int, tail_oldest_at: mixed, tail_latest_at: mixed}
     */
    public function tailCounters(string $documentId, int $generation, int $checkpointSeq): array
    {
        [$bytes, $wireBytes] = self::payloadLengths($this->database->driver());
        $query = $this->rows('collaboration_updates', $documentId, $generation)->where('seq', '>', $checkpointSeq);
        if (in_array($this->database->driver(), ['mysql', 'mariadb'], true)) {
            $query->lockForUpdate();
        }
        $tail = $query->selectRaw("coalesce(sum({$bytes}), 0) as tail_bytes, coalesce(sum({$wireBytes}), 0) as tail_wire_bytes,
            min(created_at) as tail_oldest_at, max(created_at) as tail_latest_at")->first();

        return [
            'tail_bytes' => self::int($tail->tail_bytes ?? 0),
            'tail_wire_bytes' => self::int($tail->tail_wire_bytes ?? 0),
            'tail_oldest_at' => $tail->tail_oldest_at ?? null,
            'tail_latest_at' => $tail->tail_latest_at ?? null,
        ];
    }

    /** @return array{literal-string, literal-string} SQL lengths in decoded bytes and base64 wire bytes */
    public static function payloadLengths(string $driver): array
    {
        // Before this migration every payload was canonical base64, including its padding.
        $length = 'length(payload)';
        $trimmed = match ($driver) {
            'pgsql' => "length(rtrim(convert_from(payload, 'UTF8'), '='))",
            'sqlite' => "length(rtrim(cast(payload as text), '='))",
            default => "length(trim(trailing '=' from payload))",
        };
        $decoded = $driver === 'pgsql' || $driver === 'sqlite'
            ? "({$trimmed} * 3 / 4)"
            : "({$trimmed} * 3 DIV 4)";

        return $driver === 'pgsql'
            ? ["case when payload_raw then {$length} else {$decoded} end",
                "case when payload_raw then 4 * (({$length} + 2) / 3) else {$length} end"]
            : [$decoded, $length];
    }

    /**
     * The head row of a generation FOR UPDATE, null when the generation has no log. The caller holds the document
     * lock of CollaborativeState::lock() in the same transaction.
     */
    public function lockHead(string $documentId, int $generation): ?Head
    {
        $row = $this->rows('collaboration_heads', $documentId, $generation)->lockForUpdate()->first(self::HEAD_COLUMNS);

        return $row === null ? null : self::head($row);
    }

    /** Sample the writer's clock after acquiring the head lock when inspecting a lease. */
    public function leaseClock(): Carbon
    {
        $connection = $this->database->connection();
        if ($connection->getDriverName() !== 'pgsql') {
            return Carbon::now('UTC');
        }
        $now = $connection->scalar("select clock_timestamp() at time zone 'UTC'", useReadPdo: false);

        return self::time($now, 'UTC') ?? throw new LogicException('[Vaulter] The lease clock returned no timestamp.');
    }

    public function timestamp(Carbon $utc): string
    {
        return $utc->format($this->database->connection()->getDriverName() === 'pgsql' ? 'Y-m-d H:i:s.uP' : 'Y-m-d H:i:s.u');
    }

    /**
     * The head rows `$query` selects, with every column a {@see Head} needs.
     *
     * @return list<Head>
     */
    public function heads(Builder $query): array
    {
        return array_values($query->get(self::HEAD_COLUMNS)->map(static fn (stdClass $row): Head => self::head($row))->all());
    }

    /**
     * The head rows `$filter` selects, read page by page in key order, without locks: the caller checks each again
     * under the document and head locks before it changes anything.
     *
     * @param  Closure(Builder): Builder $filter
     * @return Generator<int, Head>
     */
    public function scan(Closure $filter): Generator
    {
        $after = null;
        do {
            $query = $filter($this->table('collaboration_heads'))
                ->orderBy('document_id')
                ->orderBy('generation')
                ->limit(self::PAGE);
            if ($after !== null) {
                [$document, $generation] = $after;
                // The leading `document_id >=` repeats what the OR implies, so every engine seeks the key index to the
                // cursor instead of filtering every row before it: a late page costs what the first one does.
                $query->where('document_id', '>=', $document)->where(static fn (Builder $query): Builder => $query
                    ->where('document_id', '>', $document)
                    ->orWhere(static fn (Builder $query): Builder => $query->where('document_id', $document)->where('generation', '>', $generation)));
            }
            $page = $this->heads($query);
            foreach ($page as $head) {
                $after = [Identity::key($head->documentId), $head->generation];
                yield $head;
            }
        } while (count($page) === self::PAGE);
    }

    public static function head(stdClass $row): Head
    {
        return new Head(
            documentId: Identity::stringify($row->document_id),
            generation: self::int($row->generation),
            protocol: is_string($row->protocol) ? $row->protocol : throw new LogicException('[Vaulter] A collaboration head has no protocol.'),
            headSeq: self::int($row->head_seq),
            checkpointSeq: self::int($row->checkpoint_seq),
            checkpointVersion: self::int($row->checkpoint_version),
            leaseToken: is_string($row->lease_token) ? $row->lease_token : null,
            leaseOwner: is_string($row->lease_owner) ? $row->lease_owner : null,
            leaseExpiresAt: self::time($row->lease_expires_at, 'UTC'),
            leaseThroughSeq: $row->lease_through_seq === null ? null : self::int($row->lease_through_seq),
            drainRequestedAt: self::time($row->drain_requested_at),
            retiredAt: self::time($row->retired_at),
            profile: Identity::stringify($row->profile),
            ownerFence: self::int($row->owner_fence),
            ownerId: is_string($row->owner_id) ? $row->owner_id : null,
            ownerExpiresAt: self::time($row->owner_expires_at, 'UTC'),
            tailBytes: self::int($row->tail_bytes),
            tailWireBytes: self::int($row->tail_wire_bytes),
            tailOldestAt: self::time($row->tail_oldest_at),
            tailLatestAt: self::time($row->tail_latest_at),
        );
    }

    /** A counter column as the driver returns it (an int, or a numeric string on some drivers). */
    public static function int(mixed $value): int
    {
        return is_int($value) || (is_string($value) && is_numeric($value)) ? (int) $value : throw new LogicException('[Vaulter] A collaboration counter is not an integer.');
    }

    /** A timestamp column as the driver returns it. */
    public static function time(mixed $value, ?string $timezone = null): ?Carbon
    {
        return is_string($value) && $value !== '' ? Carbon::parse($value, $timezone) : null;
    }
}
