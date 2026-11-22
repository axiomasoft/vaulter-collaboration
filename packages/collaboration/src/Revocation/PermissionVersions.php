<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Revocation;

use Illuminate\Support\Carbon;
use Packman\Attributes\Internal;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Events\SinkWriter;

/**
 * The permission versions of v_collaboration_permission_versions: one monotonic counter per scope key,
 * `drive:<id>` or `global`. A missing row is version 0. Only {@see PermissionVersionSink} increments, in the
 * transaction of the drive's effective-permissions event, so a version never moves without the change it counts and
 * never moves back.
 */
#[Internal]
final readonly class PermissionVersions
{
    public const string TABLE = 'collaboration_permission_versions';

    /** The scope key of every drive. */
    public const string GLOBAL = 'global';

    public function __construct(
        private VaulterDatabase $database,
        private DatabaseOptions $tables,
    ) {}

    /** The scope key of a drive, or `global` for none. */
    public static function key(?string $driveId): string
    {
        return $driveId === null || $driveId === '' ? self::GLOBAL : 'drive:'.$driveId;
    }

    /** The current pair of a drive: its own version and the global one. */
    public function current(string $driveId): PermissionVersion
    {
        $drive = self::key($driveId);
        $rows = $this->database->connection()->table($this->tables->table(self::TABLE))
            ->whereIn('scope_key', [$drive, self::GLOBAL])
            ->pluck('version', 'scope_key');

        return new PermissionVersion(drive: self::counter($rows[$drive] ?? null), global: self::counter($rows[self::GLOBAL] ?? null));
    }

    /** The current version of one scope key. */
    public function of(string $scopeKey): int
    {
        return self::counter($this->database->connection()->table($this->tables->table(self::TABLE))->where('scope_key', $scopeKey)->value('version'));
    }

    /** A stored counter (an integer, or its string on drivers that return one); a missing row is 0. */
    private static function counter(mixed $value): int
    {
        return is_int($value) || (is_string($value) && ctype_digit($value)) ? (int) $value : 0;
    }

    /**
     * Count one change of `$scopeKey` in the caller's transaction (an event sink's writer): the row's version + 1, or a
     * first row of version 1. Two first changes at once both count: the one whose insert lost increments the winner's row.
     */
    public function increment(SinkWriter $writer, string $scopeKey): void
    {
        $table = $this->tables->table(self::TABLE);
        $now = Carbon::now();
        $bump = static fn (): int => $writer->connection()->table($table)->where('scope_key', $scopeKey)->increment('version', 1, ['updated_at' => $now]);

        if ($bump() === 0 && !$writer->insertOnce($table, ['scope_key' => $scopeKey, 'version' => 1, 'updated_at' => $now], 'scope_key')) {
            $bump();
        }
    }
}
