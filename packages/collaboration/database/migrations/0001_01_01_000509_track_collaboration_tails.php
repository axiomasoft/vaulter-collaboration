<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Vaulter\Collaboration\Persistence\LogTables;
use Vaulter\Collaboration\Schema\CollaborationSchema;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Schema\VaulterMigration;

return new class extends VaulterMigration
{
    public function up(): void
    {
        $helpers = app(SchemaHelpers::class);
        $heads = $helpers->table('collaboration_heads');
        $updates = $helpers->table('collaboration_updates');
        $schema = $helpers->schemaConnection();
        $schema->table($heads, static function (Blueprint $table) use ($helpers): void {
            $helpers->counterColumn($table, 'tail_bytes');
            $helpers->counterColumn($table, 'tail_wire_bytes');
            $table->timestamp('tail_oldest_at')->nullable();
            $table->timestamp('tail_latest_at')->nullable();
        });
        $schema->table($updates, static fn (Blueprint $table) => $table->boolean('payload_raw')->default(false));

        $db = $helpers->dbConnection();
        $grammar = $db->getQueryGrammar();
        $headTable = $grammar->wrapTable($heads);
        $updateTable = $grammar->wrapTable($updates);
        $driver = $db->getDriverName();
        [$bytes, $wireBytes] = LogTables::payloadLengths($driver);

        if (in_array($driver, ['pgsql', 'sqlite'], true)) {
            $db->statement("UPDATE {$headTable} SET (tail_bytes, tail_wire_bytes, tail_oldest_at, tail_latest_at) = (
                SELECT coalesce(sum({$bytes}), 0), coalesce(sum({$wireBytes}), 0), min(created_at), max(created_at)
                FROM {$updateTable} AS u
                WHERE u.document_id = {$headTable}.document_id AND u.generation = {$headTable}.generation
                    AND u.seq > {$headTable}.checkpoint_seq AND u.seq <= {$headTable}.head_seq
            ) WHERE head_seq > checkpoint_seq");
            app(CollaborationSchema::class)->dropCompactionScanIndexes();
            $drain = $grammar->wrap($heads.'_drain_scan');
            $pending = $grammar->wrap($heads.'_pending_scan');
            $db->statement("CREATE INDEX {$drain} ON {$headTable} (protocol, document_id, generation)
                WHERE drain_requested_at IS NOT NULL AND retired_at IS NULL");
            $db->statement("CREATE INDEX {$pending} ON {$headTable} (protocol, document_id, generation)
                WHERE head_seq > checkpoint_seq AND drain_requested_at IS NULL AND retired_at IS NULL");
            $index = $grammar->wrap($heads.'_retired_scan');
            $db->statement("CREATE INDEX {$index} ON {$headTable} (retired_at, document_id, generation) WHERE retired_at IS NOT NULL");
        } else {
            $db->statement("UPDATE {$headTable} AS h JOIN (
                SELECT u.document_id, u.generation, sum({$bytes}) AS bytes, sum({$wireBytes}) AS wire_bytes,
                    min(u.created_at) AS oldest_at, max(u.created_at) AS latest_at
                FROM {$updateTable} AS u JOIN {$headTable} AS head
                    ON u.document_id = head.document_id AND u.generation = head.generation
                    AND u.seq > head.checkpoint_seq AND u.seq <= head.head_seq
                GROUP BY u.document_id, u.generation
            ) AS tail ON tail.document_id = h.document_id AND tail.generation = h.generation
            SET h.tail_bytes = tail.bytes, h.tail_wire_bytes = tail.wire_bytes,
                h.tail_oldest_at = tail.oldest_at, h.tail_latest_at = tail.latest_at");
        }
    }

    public function down(): void
    {
        $helpers = app(SchemaHelpers::class);
        $heads = $helpers->table('collaboration_heads');
        $updates = $helpers->table('collaboration_updates');
        $db = $helpers->dbConnection();
        $grammar = $db->getQueryGrammar();
        if (in_array($db->getDriverName(), ['pgsql', 'sqlite'], true)) {
            $db->statement('DROP INDEX IF EXISTS '.$grammar->wrap($heads.'_retired_scan'));
            $collaboration = app(CollaborationSchema::class);
            $collaboration->dropCompactionScanIndexes();
            $collaboration->indexCompactionScans();
        }
        if ($db->getDriverName() === 'pgsql') {
            $table = $grammar->wrapTable($updates);
            $db->statement("UPDATE {$table} SET payload = convert_to(replace(encode(payload, 'base64'), chr(10), ''), 'UTF8') WHERE payload_raw");
        }

        $schema = $helpers->schemaConnection();
        $schema->table($updates, static fn (Blueprint $table) => $table->dropColumn('payload_raw'));
        $schema->table($heads, static fn (Blueprint $table) => $table->dropColumn(['tail_bytes', 'tail_wire_bytes', 'tail_oldest_at', 'tail_latest_at']));
    }
};
