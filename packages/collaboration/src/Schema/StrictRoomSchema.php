<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Schema;

use Illuminate\Database\Schema\Blueprint;
use Packman\Attributes\Internal;
use Vaulter\Contracts\IdStrategy;
use Vaulter\Schema\SchemaHelpers;

#[Internal]
final readonly class StrictRoomSchema
{
    private const int MAX_POSITION = 9007199254740991;

    public function __construct(private SchemaHelpers $helpers) {}

    public function addOwnership(): void
    {
        $db = $this->helpers->dbConnection();
        $driver = $db->getDriverName();
        $name = $this->helpers->table('collaboration_heads');
        $table = $db->getQueryGrammar()->wrapTable($name);
        $shape = $db->getQueryGrammar()->wrap($name.'_owner_shape');
        $profile = $driver === 'mysql' || $driver === 'mariadb' ? 'CAST(profile AS BINARY)' : 'profile';
        $checks = [
            $name.'_profile_check' => "$profile IN ('standard', 'strict')",
            $name.'_owner_fence_check' => 'owner_fence >= 0',
            $name.'_owner_shape' => '(owner_id IS NULL AND owner_expires_at IS NULL)
                OR (owner_id IS NOT NULL AND owner_expires_at IS NOT NULL AND owner_fence > 0)',
        ];

        if ($driver === 'sqlite') {
            $db->statement("ALTER TABLE {$table} ADD COLUMN profile VARCHAR(32) NOT NULL DEFAULT 'standard' CHECK ({$checks[$name.'_profile_check']})");
            $db->statement("ALTER TABLE {$table} ADD COLUMN owner_fence BIGINT NOT NULL DEFAULT 0 CHECK ({$checks[$name.'_owner_fence_check']})");
            $db->statement("ALTER TABLE {$table} ADD COLUMN owner_id VARCHAR(36)");
            $db->statement("ALTER TABLE {$table} ADD COLUMN owner_expires_at DATETIME CONSTRAINT {$shape} CHECK ({$checks[$name.'_owner_shape']})");

            return;
        }
        $this->timeouts();
        $this->helpers->schemaConnection()->table($name, static function (Blueprint $table): void {
            $table->string('profile', 32)->default('standard');
            $table->bigInteger('owner_fence')->default(0);
            $table->uuid('owner_id')->nullable();
            $table->timestampTz('owner_expires_at', precision: 6)->nullable();
        });
        foreach ($checks as $name => $check) {
            $constraint = $db->getQueryGrammar()->wrap($name);
            $validation = $driver === 'pgsql' ? ' NOT VALID' : '';
            $db->statement("ALTER TABLE {$table} ADD CONSTRAINT {$constraint} CHECK ({$check}){$validation}");
        }
        if ($driver === 'pgsql') {
            foreach (array_keys($checks) as $name) {
                $constraint = $db->getQueryGrammar()->wrap($name);
                $db->statement("ALTER TABLE {$table} VALIDATE CONSTRAINT {$constraint}");
            }
        }
    }

    public function dropOwnership(): void
    {
        $this->timeouts();
        $db = $this->helpers->dbConnection();
        $name = $this->helpers->table('collaboration_heads');
        if ($db->getDriverName() !== 'sqlite') {
            $table = $db->getQueryGrammar()->wrapTable($name);
            $drop = $db->getDriverName() === 'mysql' ? 'DROP CHECK' : 'DROP CONSTRAINT';
            foreach (['owner_shape', 'owner_fence_check', 'profile_check'] as $suffix) {
                $constraint = $db->getQueryGrammar()->wrap($name.'_'.$suffix);
                $db->statement("ALTER TABLE {$table} {$drop} {$constraint}");
            }
        }
        $this->helpers->schemaConnection()->table($name, static fn (Blueprint $table) => $table->dropColumn([
            'owner_expires_at', 'owner_id', 'owner_fence', 'profile',
        ]));
    }

    public function clientIds(Blueprint $table, IdStrategy $ids): void
    {
        $name = $table->getTable();
        $ids->reference($table, 'document_id');
        $this->generation($table);
        $table->rawColumn('client_id', 'BIGINT CHECK (client_id BETWEEN 1 AND 4294967295)');
        $table->bigInteger('tenant_id');
        $table->rawColumn('writer_kind', "VARCHAR(16) CHECK (writer_kind IN ('browser', 'server', 'historical'))");
        $subjectCheck = $this->inlineChecks() ? ' CHECK ('.$this->clientSubjectCheck().')' : '';
        $table->rawColumn('effective_subject', $this->scopeString().$subjectCheck)->nullable();
        $table->uuid('session_id')->nullable();
        $table->timestampTz('issued_at')->useCurrent();
        $table->primary(['document_id', 'generation', 'client_id'], $name.'_pkey');
        $table->foreign('document_id', $name.'_document_fk')->references('id')
            ->on($this->helpers->table('documents'))->cascadeOnDelete();
    }

    public function commands(Blueprint $table, IdStrategy $ids): void
    {
        $name = $table->getTable();
        $max = self::MAX_POSITION;
        $table->uuid('id')->primary();
        $table->bigInteger('tenant_id');
        $this->requiredScopeString($table, 'project_scope');
        $this->requiredScopeString($table, 'effective_subject');
        $ids->reference($table, 'resource_id');
        $ids->reference($table, 'document_id', nullable: true);
        $this->requiredScopeString($table, 'command_id');
        $table->uuid('proposal_id');
        $binary = $this->helpers->dbConnection()->getDriverName() === 'pgsql' ? 'BYTEA' : 'BLOB';
        foreach (['proposal_digest', 'fingerprint'] as $digest) {
            $table->rawColumn($digest, $binary.' CHECK ('.$this->byteLength($digest).' = 32)');
        }
        $this->generation($table);
        $table->rawColumn('schema_version', 'INTEGER CHECK (schema_version > 0)');
        $table->rawColumn('read_position', "BIGINT CHECK (read_position BETWEEN 0 AND {$max})");
        $table->rawColumn('intent', $this->jsonObject('intent'))->nullable();
        $table->rawColumn('state', "VARCHAR(16) DEFAULT 'running' CHECK (state IN ('running', 'committed', 'rejected'))");
        $table->rawColumn('owner_fence', 'BIGINT CHECK (owner_fence > 0)')->nullable();
        $checks = $this->commandChecks();
        $inline = $this->inlineChecks();
        $table->rawColumn('base_seq', 'BIGINT'.($inline ? " CHECK ({$checks['base_seq_check']})" : ''))->nullable();
        $table->rawColumn('from_seq', 'BIGINT CHECK (from_seq > 0)')->nullable();
        $table->rawColumn('to_seq', "BIGINT CHECK (to_seq BETWEEN 0 AND {$max})")->nullable();
        $table->uuid('receipt_id')->nullable()->unique();
        $table->rawColumn('evidence', $this->jsonObject('evidence'))->nullable();
        $table->rawColumn('rejection_code', 'VARCHAR(64) CHECK ('.$this->byteLength('rejection_code').' BETWEEN 1 AND 64)')->nullable();
        $table->timestampTz('registered_at', precision: 6);
        $table->timestampTz('finalized_at', precision: 6)->nullable();
        $table->timestampTz('evidence_expires_at', precision: 6)->nullable();
        $timestamp = $this->helpers->dbConnection()->getDriverName() === 'pgsql' ? 'TIMESTAMPTZ' : 'DATETIME(6)';
        $table->rawColumn('replay_until', $timestamp.($inline ? " CHECK ({$checks['replay_until_check']})" : ''));
        $shape = $inline ? " CONSTRAINT {$name}_times CHECK ({$checks['times']}) CONSTRAINT {$name}_shape CHECK ({$checks['shape']})" : '';
        $table->rawColumn('redacted_at', $timestamp.$shape)->nullable();
        $table->unique(['tenant_id', 'project_scope', 'effective_subject', 'resource_id', 'command_id'], $name.'_scope');
        $table->index('document_id', $name.'_doc_fk');
        if (!$inline) {
            $table->unique(['resource_id', 'generation', 'from_seq'], $name.'_first_seq');
        }
        $table->foreign('document_id', $name.'_document_fk')->references('id')
            ->on($this->helpers->table('documents'))->nullOnDelete();
    }

    /** @return array<string, string> */
    private function commandChecks(): array
    {
        return [
            'base_seq_check' => 'base_seq BETWEEN read_position AND '.self::MAX_POSITION,
            'replay_until_check' => 'replay_until >= registered_at',
            'times' => '
                (finalized_at IS NULL OR finalized_at >= registered_at)
                AND (evidence_expires_at IS NULL OR (finalized_at IS NOT NULL AND evidence_expires_at >= finalized_at))
                AND (redacted_at IS NULL OR (finalized_at IS NOT NULL AND redacted_at >= finalized_at))',
            'shape' => "
                (state = 'running' AND intent IS NOT NULL AND owner_fence IS NULL
                 AND finalized_at IS NULL AND base_seq IS NULL AND from_seq IS NULL AND to_seq IS NULL
                 AND receipt_id IS NULL AND evidence IS NULL AND evidence_expires_at IS NULL
                 AND rejection_code IS NULL AND redacted_at IS NULL)
                OR (state = 'committed' AND finalized_at IS NOT NULL AND receipt_id IS NOT NULL
                    AND owner_fence IS NOT NULL AND base_seq IS NOT NULL AND to_seq IS NOT NULL
                    AND rejection_code IS NULL AND evidence_expires_at IS NOT NULL
                    AND ((from_seq IS NULL AND to_seq = base_seq)
                         OR (from_seq IS NOT NULL AND from_seq = base_seq + 1 AND to_seq >= from_seq))
                    AND ((evidence IS NOT NULL AND redacted_at IS NULL)
                         OR (evidence IS NULL AND redacted_at IS NOT NULL AND redacted_at >= evidence_expires_at)))
                OR (state = 'rejected' AND finalized_at IS NOT NULL AND rejection_code IS NOT NULL
                    AND receipt_id IS NULL AND from_seq IS NULL AND to_seq IS NULL
                    AND evidence IS NULL AND evidence_expires_at IS NULL)
            ",
        ];
    }

    public function indexCommands(): void
    {
        $db = $this->helpers->dbConnection();
        $partial = $this->inlineChecks();
        if ($partial) {
            $name = $this->helpers->table('collaboration_commands');
            $table = $db->getQueryGrammar()->wrapTable($name);
            $index = $db->getQueryGrammar()->wrap($name.'_first_seq');
            $db->statement("CREATE UNIQUE INDEX {$index} ON {$table} (resource_id, generation, from_seq) WHERE from_seq IS NOT NULL");
        } else {
            // MySQL requires checks that reference multiple columns to be table constraints.
            $this->addTableChecks('collaboration_client_ids', ['subject_check' => $this->clientSubjectCheck()]);
            $this->addTableChecks('collaboration_commands', $this->commandChecks());
        }
        foreach ([
            ['collaboration_client_ids', 'session', 'document_id, generation, session_id', 'session_id IS NOT NULL'],
            ['collaboration_commands', 'pending', 'document_id, generation, registered_at, id', "state = 'running'"],
            ['collaboration_commands', 'expiring', 'evidence_expires_at, id', "state = 'committed' AND redacted_at IS NULL"],
        ] as [$entity, $suffix, $columns, $predicate]) {
            $name = $this->helpers->table($entity);
            $table = $db->getQueryGrammar()->wrapTable($name);
            $index = $db->getQueryGrammar()->wrap($name.'_'.$suffix);
            $where = $partial ? ' WHERE '.$predicate : '';
            $db->statement("CREATE INDEX {$index} ON {$table} ({$columns}){$where}");
        }
    }

    private function inlineChecks(): bool
    {
        return in_array($this->helpers->dbConnection()->getDriverName(), ['pgsql', 'sqlite'], true);
    }

    private function clientSubjectCheck(): string
    {
        $length = $this->byteLength('effective_subject');

        return "(writer_kind = 'historical' AND effective_subject IS NULL)
            OR (writer_kind IN ('browser', 'server') AND effective_subject IS NOT NULL AND {$length} BETWEEN 1 AND 255)";
    }

    /** @param array<string, string> $checks */
    private function addTableChecks(string $entity, array $checks): void
    {
        $db = $this->helpers->dbConnection();
        $name = $this->helpers->table($entity);
        $table = $db->getQueryGrammar()->wrapTable($name);
        foreach ($checks as $suffix => $expression) {
            $constraint = $db->getQueryGrammar()->wrap($name.'_'.$suffix);
            $db->statement("ALTER TABLE {$table} ADD CONSTRAINT {$constraint} CHECK ({$expression})");
        }
    }

    private function generation(Blueprint $table): void
    {
        $table->rawColumn('generation', 'BIGINT CHECK (generation BETWEEN 0 AND '.self::MAX_POSITION.')');
    }

    private function scopeString(): string
    {
        return match ($this->helpers->dbConnection()->getDriverName()) {
            'pgsql' => 'VARCHAR(255) COLLATE "C"',
            'sqlite' => 'VARCHAR(255) COLLATE BINARY',
            default => 'VARBINARY(255)',
        };
    }

    private function requiredScopeString(Blueprint $table, string $column): void
    {
        $table->rawColumn($column, $this->scopeString().' CHECK ('.$this->byteLength($column).' BETWEEN 1 AND 255)');
    }

    private function byteLength(string $column): string
    {
        return $this->helpers->dbConnection()->getDriverName() === 'sqlite'
            ? "length(CAST({$column} AS BLOB))" : "octet_length({$column})";
    }

    private function jsonObject(string $column): string
    {
        return $this->helpers->dbConnection()->getDriverName() === 'pgsql'
            ? "JSONB CHECK (jsonb_typeof({$column}) = 'object')"
            : "JSON CHECK (lower(json_type({$column})) = 'object')";
    }

    private function timeouts(): void
    {
        $db = $this->helpers->dbConnection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement("SET LOCAL lock_timeout = '2s'");
            $db->statement("SET LOCAL statement_timeout = '15s'");
        }
    }
}
