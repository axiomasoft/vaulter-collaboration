<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Schema;

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
 * the working state, the generation (`collab_epoch`) and the pending marker stay in v_documents and change through the
 * documents state contract. The permission versions reference nothing: a drive's key is a string, and the drive adds no
 * column for collaboration.
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
        ];
    }

    /** @return list<KeyColumnExpectation> the key columns of the module's tables and the kind each must have: `HK` host key, `REF` entity id, `STRING` of a length */
    public function keyColumns(): array
    {
        return [
            new KeyColumnExpectation('collaboration_heads', 'document_id', 'REF'),
            new KeyColumnExpectation('collaboration_updates', 'document_id', 'REF'),
            new KeyColumnExpectation('collaboration_receipts', 'document_id', 'REF'),
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
                default => throw new InvalidArgumentException(sprintf('Unknown collaboration entity [%s].', $entity)),
            };
        });
    }

    public function drop(string $entity): void
    {
        $this->helpers->schemaConnection()->dropIfExists($this->helpers->table($entity));
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
        $table->timestamp('lease_expires_at')->nullable();
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
