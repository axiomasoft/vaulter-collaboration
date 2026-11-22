<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Support;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Vaulter\Collaboration\Revocation\ControlConsumer;
use Vaulter\Collaboration\Revocation\PermissionVersion;
use Vaulter\Collaboration\Revocation\PermissionVersions;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers;
use Vaulter\Documents\Actions\Documents\CreateDocumentAction;
use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Access\ValueObjects\Subject;
use Vaulter\Drive\Contracts\DriveHandle;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Data\Snapshots\GrantSnapshot;
use Vaulter\Drive\Data\Snapshots\NodeSnapshot;
use Vaulter\Drive\Models\Node;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Events\Outbox\OutboxRelay;
use Vaulter\Testing\Fixtures\TestUser;

/**
 * Fixtures of the revocation tests: a document whose subject holds its rights through a grant on the folder above it
 * (inherited, so revoking it is an ancestor change), the subject of the hub's test user, the permission versions of a
 * drive, the claims of a token and one relay pass of the control consumer.
 */
final class Revocation
{
    /**
     * A document in folder "Team" of a fresh drive; actor 1 holds `$role` on the folder (a subtree grant).
     *
     * @return array{drive: DriveHandle, folder: NodeSnapshot, grant: GrantSnapshot, node: Node}
     */
    public static function inheritedDocument(string $role = RoleRegistry::WRITER, int $actorId = 1): array
    {
        $drive = DocumentTestHelpers::drive();
        $folder = $drive->folders()->create('Team');
        $grant = $drive->access()->grant($folder->id, new GrantInput(subject: self::subject($actorId), role: $role));
        $node = app(CreateDocumentAction::class)->execute(DocumentTestHelpers::context($drive->model()), new CreateDocumentInput(
            storage: $drive->model(),
            name: 'Spec',
            content: DocumentTestHelpers::content('Draft'),
            parent: DriveTestHelpers::model($folder),
        ));

        return ['drive' => $drive, 'folder' => $folder, 'grant' => $grant, 'node' => $node];
    }

    /** The grant subject of the host user the hub's tokens name. */
    public static function subject(int $actorId = 1): Subject
    {
        return new Subject((new TestUser)->getMorphClass(), $actorId);
    }

    public static function versions(Node $node): PermissionVersion
    {
        return app(PermissionVersions::class)->current((string) $node->drive_id);
    }

    public static function globalVersion(): int
    {
        return app(PermissionVersions::class)->of(PermissionVersions::GLOBAL);
    }

    /** @return array<string, mixed> the verified claims of a room token, by the application clock (time travel included) */
    public static function claims(string $token): array
    {
        JWT::$timestamp = now()->getTimestamp();
        try {
            $claims = json_decode((string) json_encode(JWT::decode($token, new Key(HubTestHelpers::JWT_SECRET, 'HS256'))), true);
        } finally {
            JWT::$timestamp = null;
        }

        return is_array($claims) ? $claims : [];
    }

    /** One relay pass of the control consumer: register, reconcile, deliver. */
    public static function relayControl(): void
    {
        app(OutboxRelay::class)->pass(ControlConsumer::ID);
    }
}
