<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Support;

use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Str;
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
        return DocumentRevision::query()->where('document_id', self::document($node)->getKey())->orderBy('number')->get();
    }

    public static function head(Node $node): DocumentRevision
    {
        return DocumentRevision::query()->whereKey(self::document($node)->current_revision_id)->firstOrFail();
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
