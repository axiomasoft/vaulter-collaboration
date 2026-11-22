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
        'document_id', 'generation', 'head_seq', 'checkpoint_seq', 'checkpoint_version',
        'lease_token', 'lease_owner', 'lease_expires_at', 'drain_requested_at', 'retired_at',
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
     * The head row of a generation FOR UPDATE, null when the generation has no log. The caller holds the document
     * lock of CollaborativeState::lock() in the same transaction.
     */
    public function lockHead(string $documentId, int $generation): ?Head
    {
        $row = $this->rows('collaboration_heads', $documentId, $generation)->lockForUpdate()->first(self::HEAD_COLUMNS);

        return $row === null ? null : self::head($row);
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
                $query->where(static fn (Builder $query): Builder => $query
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
            headSeq: self::int($row->head_seq),
            checkpointSeq: self::int($row->checkpoint_seq),
            checkpointVersion: self::int($row->checkpoint_version),
            leaseToken: is_string($row->lease_token) ? $row->lease_token : null,
            leaseOwner: is_string($row->lease_owner) ? $row->lease_owner : null,
            leaseExpiresAt: self::time($row->lease_expires_at),
            drainRequestedAt: self::time($row->drain_requested_at),
            retiredAt: self::time($row->retired_at),
        );
    }

    /** A counter column as the driver returns it (an int, or a numeric string on some drivers). */
    public static function int(mixed $value): int
    {
        return is_int($value) || (is_string($value) && is_numeric($value)) ? (int) $value : throw new LogicException('[Vaulter] A collaboration counter is not an integer.');
    }

    /** A timestamp column as the driver returns it. */
    public static function time(mixed $value): ?Carbon
    {
        return is_string($value) && $value !== '' ? Carbon::parse($value) : null;
    }
}
