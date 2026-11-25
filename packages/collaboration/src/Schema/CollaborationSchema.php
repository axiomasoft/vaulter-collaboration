<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Schema;

use Illuminate\Database\Query\Builder;
use Illuminate\Database\Schema\Blueprint;
use InvalidArgumentException;
use Packman\Attributes\Internal;
use Vaulter\Contracts\IdStrategy;
use Vaulter\Schema\ModuleSchema;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Schema\ValueObjects\KeyColumnExpectation;

/**
 * The side tables the collaboration module owns: the update log of a document generation, its committed receipts
 * and its head, and the permission versions of the drives. The log tables reference the documents aggregate only;
 * the generation (`collab_epoch`), working payload, binary checkpoint and pending marker belong to the Documents
 * module and change through its state contract. The permission versions reference nothing: a drive's key is a string,
 * and the drive adds no column for collaboration.
 */
#[Internal]
final class CollaborationSchema implements ModuleSchema
{
    public function __construct(private readonly SchemaHelpers $helpers) {}

    /** @return list<string> the entity keys of the tables this schema owns, in dependency order */
    public function entities(): array
    {
        return [
            'collaboration_heads',
            'collaboration_updates',
            'collaboration_receipts',
            'collaboration_permission_versions',
            'collaboration_client_ids',
            'collaboration_commands',
        ];
    }

    /** @return list<KeyColumnExpectation> the key columns of the module's tables and the kind each must have: `HK` host key, `REF` entity id, `STRING` of a length */
    public function keyColumns(): array
    {
        return [
            new KeyColumnExpectation('collaboration_heads', 'document_id', 'REF'),
            new KeyColumnExpectation('collaboration_updates', 'document_id', 'REF'),
            new KeyColumnExpectation('collaboration_receipts', 'document_id', 'REF'),
            new KeyColumnExpectation('collaboration_client_ids', 'document_id', 'REF'),
            new KeyColumnExpectation('collaboration_commands', 'document_id', 'REF'),
        ];
    }

    public function create(string $entity): void
    {
        $ids = $this->helpers->ids();

        $this->helpers->schemaConnection()->create($this->helpers->table($entity), function (Blueprint $table) use ($ids, $entity): void {
            match ($entity) {
                'collaboration_heads' => $this->defineHeads(table: $table, ids: $ids),
                'collaboration_updates' => $this->defineUpdates(table: $table, ids: $ids),
                'collaboration_receipts' => $this->defineReceipts(table: $table, ids: $ids),
                'collaboration_permission_versions' => $this->definePermissionVersions(table: $table),
                'collaboration_client_ids' => new StrictRoomSchema($this->helpers)->clientIds($table, $ids),
                'collaboration_commands' => new StrictRoomSchema($this->helpers)->commands($table, $ids),
                default => throw new InvalidArgumentException(sprintf('Unknown collaboration entity [%s].', $entity)),
            };
        });
    }

    public function drop(string $entity): void
    {
        $this->helpers->schemaConnection()->dropIfExists($this->helpers->table($entity));
    }

    public function boundCompactionLeases(): void
    {
        $db = $this->helpers->dbConnection();
        $driver = $db->getDriverName();
        $name = $this->helpers->table('collaboration_heads');
        $table = $db->getQueryGrammar()->wrapTable($name);
        $protocol = $db->getQueryGrammar()->wrap($name.'_protocol_check');
        $lease = $db->getQueryGrammar()->wrap($name.'_compaction_lease');
        $checkpoint = $db->getQueryGrammar()->wrap($name.'_checkpoint_seq_check');
        $covered = $driver === 'sqlite' ? "typeof(lease_through_seq) = 'integer' AND " : '';
        $leaseCheck = "CHECK (
            (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL AND lease_through_seq IS NULL)
            OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
                AND lease_through_seq IS NOT NULL AND {$covered}lease_through_seq BETWEEN checkpoint_seq AND head_seq)
        )";

        if ($driver === 'pgsql') {
            $db->statement("SET LOCAL lock_timeout = '2s'");
            $db->statement("SET LOCAL statement_timeout = '15s'");
            $db->statement("LOCK TABLE {$table} IN SHARE ROW EXCLUSIVE MODE");
            // PostgreSQL named the original counter's inline CHECK after its column.
            $db->statement("ALTER TABLE {$table} DROP CONSTRAINT {$checkpoint}");
        }
        // A lease issued by the old schema has no provable upper bound. Its log and marker stay available to re-lease.
        $db->table($name)->where(static fn (Builder $query): Builder => $query->whereNotNull('lease_token')
            ->orWhereNotNull('lease_owner')->orWhereNotNull('lease_expires_at'))->update([
                'lease_token' => null,
                'lease_owner' => null,
                'lease_expires_at' => null,
            ]);

        if ($driver === 'sqlite') {
            $db->statement("ALTER TABLE {$table} ADD COLUMN protocol VARCHAR(64) NOT NULL DEFAULT 'yjs/2'
                CONSTRAINT {$protocol} CHECK (length(trim(protocol, char(9,10,11,12,13,32))) BETWEEN 1 AND 64)");
            $db->statement("ALTER TABLE {$table} ADD COLUMN lease_through_seq BIGINT
                CONSTRAINT {$lease} {$leaseCheck} CONSTRAINT {$checkpoint} CHECK (checkpoint_seq BETWEEN 0 AND head_seq)");

            return;
        }

        $protocolCheck = $driver === 'pgsql' ? "protocol ~ '[^[:space:]]'" : "protocol REGEXP '[^[:space:]]'";
        $validation = $driver === 'pgsql' ? ' NOT VALID' : '';
        $db->statement("ALTER TABLE {$table}
            ADD COLUMN protocol VARCHAR(64) NOT NULL DEFAULT 'yjs/2',
            ADD COLUMN lease_through_seq BIGINT NULL,
            ADD CONSTRAINT {$protocol} CHECK ({$protocolCheck}){$validation},
            ADD CONSTRAINT {$lease} {$leaseCheck}{$validation},
            ADD CONSTRAINT {$checkpoint} CHECK (checkpoint_seq BETWEEN 0 AND head_seq){$validation}");
        if ($driver === 'pgsql') {
            $db->statement("ALTER TABLE {$table} VALIDATE CONSTRAINT {$protocol}, VALIDATE CONSTRAINT {$lease}, VALIDATE CONSTRAINT {$checkpoint}");
        }
    }

    public function dropCompactionLeaseBound(): void
    {
        $db = $this->helpers->dbConnection();
        $driver = $db->getDriverName();
        $name = $this->helpers->table('collaboration_heads');
        $table = $db->getQueryGrammar()->wrapTable($name);

        if ($driver === 'pgsql') {
            $db->statement("SET LOCAL lock_timeout = '2s'");
            $db->statement("SET LOCAL statement_timeout = '15s'");
        }
        if ($driver !== 'sqlite') {
            $drop = $driver === 'mysql' ? 'DROP CHECK' : 'DROP CONSTRAINT';
            $constraints = array_map(
                fn (string $suffix): string => $drop.' '.$db->getQueryGrammar()->wrap($name.'_'.$suffix),
                ['protocol_check', 'compaction_lease', 'checkpoint_seq_check'],
            );
            $db->statement("ALTER TABLE {$table} ".implode(', ', $constraints));
        }
        $db->table($name)->whereNotNull('lease_token')->update([
            'lease_token' => null,
            'lease_owner' => null,
            'lease_expires_at' => null,
            'lease_through_seq' => null,
        ]);
        if ($driver === 'pgsql') {
            $checkpoint = $db->getQueryGrammar()->wrap($name.'_checkpoint_seq_check');
            $db->statement("ALTER TABLE {$table} ADD CONSTRAINT {$checkpoint} CHECK (checkpoint_seq >= 0)");
        }
        $this->helpers->schemaConnection()->table($name, static fn (Blueprint $table) => $table->dropColumn(['lease_through_seq', 'protocol']));
    }

    public function alignLeaseExpiresAt(): void
    {
        $db = $this->helpers->dbConnection();
        $driver = $db->getDriverName();
        if ($driver === 'sqlite') {
            return;
        }
        $name = $this->helpers->table('collaboration_heads');
        $table = $db->getQueryGrammar()->wrapTable($name);
        if ($driver === 'pgsql') {
            $lease = $db->getQueryGrammar()->wrap($name.'_compaction_lease');
            $leaseCheck = 'CHECK (
                (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL AND lease_through_seq IS NULL)
                OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
                    AND lease_through_seq IS NOT NULL AND lease_through_seq BETWEEN checkpoint_seq AND head_seq)
            )';
            $db->statement("SET LOCAL lock_timeout = '2s'");
            $db->statement("SET LOCAL statement_timeout = '15s'");
            $db->statement("LOCK TABLE {$table} IN SHARE ROW EXCLUSIVE MODE");
            $db->statement("ALTER TABLE {$table} DROP CONSTRAINT IF EXISTS {$lease}");
            $db->statement("ALTER TABLE {$table} ALTER COLUMN lease_expires_at TYPE TIMESTAMPTZ(6) USING lease_expires_at AT TIME ZONE 'UTC'");
            $db->statement("ALTER TABLE {$table} ADD CONSTRAINT {$lease} {$leaseCheck} NOT VALID");
            $db->statement("ALTER TABLE {$table} VALIDATE CONSTRAINT {$lease}");

            return;
        }
        $db->statement("ALTER TABLE {$table} MODIFY COLUMN lease_expires_at TIMESTAMP(6) NULL");
    }

    public function revertLeaseExpiresAt(): void
    {
        $db = $this->helpers->dbConnection();
        $driver = $db->getDriverName();
        if ($driver === 'sqlite') {
            return;
        }
        $name = $this->helpers->table('collaboration_heads');
        $table = $db->getQueryGrammar()->wrapTable($name);
        if ($driver === 'pgsql') {
            $lease = $db->getQueryGrammar()->wrap($name.'_compaction_lease');
            $leaseCheck = 'CHECK (
                (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL AND lease_through_seq IS NULL)
                OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
                    AND lease_through_seq IS NOT NULL AND lease_through_seq BETWEEN checkpoint_seq AND head_seq)
            )';
            $db->statement("SET LOCAL lock_timeout = '2s'");
            $db->statement("SET LOCAL statement_timeout = '15s'");
            $db->statement("LOCK TABLE {$table} IN SHARE ROW EXCLUSIVE MODE");
            $db->statement("ALTER TABLE {$table} DROP CONSTRAINT IF EXISTS {$lease}");
            $db->statement("ALTER TABLE {$table} ALTER COLUMN lease_expires_at TYPE TIMESTAMP(0) WITHOUT TIME ZONE USING lease_expires_at AT TIME ZONE 'UTC'");
            $db->statement("ALTER TABLE {$table} ADD CONSTRAINT {$lease} {$leaseCheck} NOT VALID");
            $db->statement("ALTER TABLE {$table} VALIDATE CONSTRAINT {$lease}");

            return;
        }
        $db->statement("ALTER TABLE {$table} MODIFY COLUMN lease_expires_at TIMESTAMP NULL");
    }

    /**
     * Partial indexes for the two head scans of every compaction lease call (each hub every few seconds): the drain
     * requests, then the generations with uncheckpointed updates. Without them both scans walk every open head in
     * key order, so their cost grows with the documents ever opened and not with the work due. MySQL and MariaDB have no
     * partial indexes; there the scans keep walking the primary key.
     */
    public function indexCompactionScans(): void
    {
        $db = $this->helpers->dbConnection();
        if (!in_array($db->getDriverName(), ['pgsql', 'sqlite'], true)) {
            return;
        }
        $name = $this->helpers->table('collaboration_heads');
        $grammar = $db->getQueryGrammar();
        $table = $grammar->wrapTable($name);
        $db->statement('CREATE INDEX '.$grammar->wrap($name.'_drain_scan')." ON {$table} (document_id, generation)
            WHERE drain_requested_at IS NOT NULL AND retired_at IS NULL");
        $db->statement('CREATE INDEX '.$grammar->wrap($name.'_pending_scan')." ON {$table} (document_id, generation)
            WHERE head_seq > checkpoint_seq AND drain_requested_at IS NULL AND retired_at IS NULL");
    }

    public function dropCompactionScanIndexes(): void
    {
        $db = $this->helpers->dbConnection();
        if (!in_array($db->getDriverName(), ['pgsql', 'sqlite'], true)) {
            return;
        }
        $name = $this->helpers->table('collaboration_heads');
        $grammar = $db->getQueryGrammar();
        $db->statement('DROP INDEX IF EXISTS '.$grammar->wrap($name.'_drain_scan'));
        $db->statement('DROP INDEX IF EXISTS '.$grammar->wrap($name.'_pending_scan'));
    }

    /**
     * v_collaboration_heads — one row per document generation: the last committed log sequence (head_seq), the sequence
     * and state version the last published checkpoint covers, the compaction lease and the drain request. A row is
     * created under the document lock by the first append of its generation; retired_at closes the generation.
     */
    private function defineHeads(Blueprint $table, IdStrategy $ids): void
    {
        $ids->reference(table: $table, column: 'document_id');
        $this->helpers->counterColumn(table: $table, column: 'generation');
        $this->helpers->counterColumn(table: $table, column: 'head_seq');
        $this->helpers->counterColumn(table: $table, column: 'checkpoint_seq');
        $this->helpers->counterColumn(table: $table, column: 'checkpoint_version');
        $table->string('lease_token', 64)->nullable();
        $table->string('lease_owner', 191)->nullable();
        $table->timestampTz('lease_expires_at', precision: 6)->nullable();
        $table->timestamp('drain_requested_at')->nullable();
        $table->timestamp('retired_at')->nullable();
        $table->timestamps();

        $name = $table->getTable();

        $table->primary(['document_id', 'generation'], $name.'_pkey');

        $table->foreign('document_id', $name.'_document_fk')
            ->references('id')
            ->on($this->helpers->table('documents'))
            ->cascadeOnDelete();
    }

    /**
     * v_collaboration_updates — the binary Yjs updates of a generation in commit order. seq is head_seq + 1 under the
     * head lock; update_id is the client's stable id, unique within the generation. A publication deletes the payloads
     * its checkpoint covers; the receipts stay.
     */
    private function defineUpdates(Blueprint $table, IdStrategy $ids): void
    {
        $ids->reference(table: $table, column: 'document_id');
        $this->helpers->counterColumn(table: $table, column: 'generation');
        $this->helpers->counterColumn(table: $table, column: 'seq');
        $table->char('update_id', 36);
        $this->helpers->binaryColumn(table: $table, column: 'payload');
        $table->char('sha256', 64);
        $table->timestamp('created_at')->nullable();

        $name = $table->getTable();

        $table->primary(['document_id', 'generation', 'seq'], $name.'_pkey');
        $table->unique(['document_id', 'generation', 'update_id'], $name.'_update_uniq');

        $table->foreign('document_id', $name.'_document_fk')
            ->references('id')
            ->on($this->helpers->table('documents'))
            ->cascadeOnDelete();
    }

    /**
     * v_collaboration_receipts — the committed receipt of every update of a generation: a repeated update_id answers
     * with its seq, a different payload under the same id is refused. Receipts outlive the compaction of their payload
     * and go only with the prune of a retired generation.
     */
    private function defineReceipts(Blueprint $table, IdStrategy $ids): void
    {
        $ids->reference(table: $table, column: 'document_id');
        $this->helpers->counterColumn(table: $table, column: 'generation');
        $table->char('update_id', 36);
        $this->helpers->counterColumn(table: $table, column: 'seq');
        $table->char('sha256', 64);
        $table->timestamp('committed_at')->nullable();

        $name = $table->getTable();

        $table->primary(['document_id', 'generation', 'update_id'], $name.'_pkey');

        $table->foreign('document_id', $name.'_document_fk')
            ->references('id')
            ->on($this->helpers->table('documents'))
            ->cascadeOnDelete();
    }

    /**
     * v_collaboration_permission_versions — one counter per scope of effective permissions: `drive:<id>` for a
     * drive, `global` for every drive. The `collaboration.permissions` event sink increments it in the transaction of
     * drive.access.effective_permissions_changed; a session token carries the drive's and the global version it was
     * issued under, so a token older than either is known to predate a change of rights.
     */
    private function definePermissionVersions(Blueprint $table): void
    {
        $table->string('scope_key', 191);
        $this->helpers->counterColumn(table: $table, column: 'version');
        $table->timestamp('updated_at')->nullable();

        $table->primary(['scope_key'], $table->getTable().'_pkey');
    }
}
