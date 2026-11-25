<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Support;

use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use RuntimeException;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Documents\Content\TipTap\TipTapContent;
use Vaulter\Documents\Models\Documents\Document;
use Vaulter\Documents\Models\Revisions\DocumentRevision;
use Vaulter\Documents\Types\DocumentTypeRegistry;
use Vaulter\Drive\DriveHandle;
use Vaulter\Drive\Models\Drive;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Testing\Fixtures\TestUser;
use Vaulter\ValueObjects\Access\Actor;

/**
 * Builders for the collaboration tests: a Drive handle, a quick TipTap document and the documents' state, read fresh.
 */
final class DocumentTestHelpers
{
    public static function drive(): DriveHandle
    {
        return DriveTestHelpers::drive();
    }

    /**
     * A small TipTap doc with one paragraph of the given text.
     */
    public static function content(string $text = 'Hello'): TipTapContent
    {
        return TipTapContent::fromArray([
            'type' => 'doc',
            'content' => [
                [
                    'type' => 'paragraph',
                    'content' => [
                        ['type' => 'text', 'text' => $text],
                    ],
                ],
            ],
        ]);
    }

    /** The document aggregate of a node, read fresh. */
    public static function document(Node $node): Document
    {
        return Document::query()->where('node_id', $node->getKey())->firstOrFail();
    }

    /**
     * The node's checkpoints, oldest number first.
     *
     * @return Collection<int, DocumentRevision>
     */
    public static function revisions(Node $node): Collection
    {
        return DocumentRevision::query()->with(['payload', 'syncState'])->where('document_id', self::document($node)->getKey())->orderBy('number')->get();
    }

    public static function head(Node $node): DocumentRevision
    {
        return DocumentRevision::query()->whereKey(self::document($node)->current_revision_id)->firstOrFail();
    }

    /** @return array<string, mixed> */
    public static function storedAttributes(Document $document): array
    {
        return self::readStoredBytes(
            $document->getAttributes() + ($document->payload?->getAttributes() ?? []) + ($document->syncState?->getAttributes() ?? []),
        );
    }

    /** @return array<string, list<array<string, mixed>>> */
    public static function storedRows(string ...$additionalEntities): array
    {
        $tables = app(DatabaseOptions::class);
        $snapshot = [];
        foreach ([
            'documents', 'document_payloads', 'document_sync_states',
            'document_revisions', 'document_revision_payloads', 'document_revision_sync_states',
            ...$additionalEntities,
        ] as $entity) {
            $snapshot[$entity] = DB::table($tables->table($entity))->get()
                ->map(static fn (object $row): array => self::readStoredBytes((array) $row))->all();
        }

        return $snapshot;
    }

    /**
     * @param  array<string, mixed> $attributes
     * @return array<string, mixed>
     */
    private static function readStoredBytes(array $attributes): array
    {
        // PDO PostgreSQL returns bytea as streams. The snapshot owns each freshly read row.
        return array_map(static function (mixed $value): mixed {
            if (!is_resource($value)) {
                return $value;
            }
            $bytes = stream_get_contents($value);

            return $bytes === false ? throw new RuntimeException('Unable to read stored document bytes.') : $bytes;
        }, $attributes);
    }

    /**
     * The operation context a direct Action call runs under: the drive of $target, as
     * the system, or as the test user $actorId when given.
     */
    public static function context(Drive|Node|DriveHandle $target, int|string|null $actorId = null): DriveContext
    {
        $drive = match (true) {
            $target instanceof Node => $target->storage()->firstOrFail(),
            $target instanceof DriveHandle => $target->model(),
            default => $target,
        };
        if ($actorId === null) {
            return DriveContext::system($drive, 'test fixture');
        }
        $user = new TestUser;
        $user->forceFill(['id' => $actorId]);
        $user->exists = true;

        return DriveContext::for($drive, Actor::user($user), (string) Str::ulid());
    }

    /**
     * Replaces the booted document type registry with one holding exactly $types, the way a host installs an extension.
     *
     * @param list<class-string> $types
     */
    public static function installTypes(array $types): DocumentTypeRegistry
    {
        $registry = new DocumentTypeRegistry(app());
        foreach ($types as $type) {
            $registry->register($type);
        }
        $registry->freeze();
        app()->instance(DocumentTypeRegistry::class, $registry);

        return $registry;
    }
}
