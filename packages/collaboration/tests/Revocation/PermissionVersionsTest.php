<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Vaulter\Collaboration\Revocation\PermissionVersion;
use Vaulter\Collaboration\Revocation\PermissionVersions;
use Vaulter\Collaboration\Revocation\PermissionVersionSink;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Revocation;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Drive\Access\AccessInvalidation;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Data\DriveRef;
use Vaulter\Events\EventSink;
use Vaulter\Events\SinkWriter;
use Vaulter\Kernel;
use Vaulter\Modules\SlotContribution;

/**
 * v_collaboration_permission_versions: the collaboration.permissions sink counts every
 * drive.access.effective_permissions_changed in the version of its drive, or in the global version, in the transaction
 * of the change. Versions only move forward and only with a committed change.
 */
beforeEach(function (): void {
    Hub::configure();
});

function permissionVersionRows(): array
{
    return DB::table(app(DatabaseOptions::class)->table(PermissionVersions::TABLE))->orderBy('scope_key')->pluck('version', 'scope_key')->map(static fn (mixed $version): int => (int) $version)->all();
}

it('contributes the counting sink to the active module graph', function (): void {
    $ids = array_map(static fn (SlotContribution $contribution): string => $contribution->id, app(Kernel::class)->extensions()->contributions(EventSink::class));

    expect($ids)->toContain(PermissionVersionSink::ID);
});

it('starts every drive at version 0 without a row', function (): void {
    ['node' => $node] = Revocation::inheritedDocument();
    DB::table(app(DatabaseOptions::class)->table(PermissionVersions::TABLE))->delete();

    expect(Revocation::versions($node))->toEqual(new PermissionVersion(drive: 0, global: 0))
        ->and(permissionVersionRows())->toBe([]);
});

it('counts each change of a drive\'s permissions once in its own version, and nothing else in it', function (): void {
    ['drive' => $drive, 'folder' => $folder, 'grant' => $grant, 'node' => $node] = Revocation::inheritedDocument();
    $before = Revocation::versions($node);

    $drive->access()->grant($folder->id, new GrantInput(subject: Revocation::subject(2), role: RoleRegistry::READER));
    $drive->access()->revoke($folder->id, $grant);
    // Not a change of permissions: no count.
    $drive->nodes()->rename($folder->id, 'Renamed');

    expect(Revocation::versions($node))->toEqual(new PermissionVersion(drive: $before->drive + 2, global: $before->global));
});

it('keeps the versions of two drives apart', function (): void {
    ['node' => $first] = Revocation::inheritedDocument();
    ['drive' => $other, 'node' => $second] = Revocation::inheritedDocument();
    $before = Revocation::versions($first)->drive;

    $other->archive();

    expect(Revocation::versions($first)->drive)->toBe($before)
        ->and(Revocation::versions($second)->drive)->toBeGreaterThan($before);
});

it('counts a global change in the global version only', function (): void {
    ['node' => $node] = Revocation::inheritedDocument();
    $before = Revocation::versions($node);

    app(AccessInvalidation::class)->changed(null, 'host-role');
    app(AccessInvalidation::class)->changed(null, 'host-role');

    expect(Revocation::versions($node))->toEqual(new PermissionVersion(drive: $before->drive, global: $before->global + 2))
        ->and(permissionVersionRows()[PermissionVersions::GLOBAL])->toBe($before->global + 2);
});

it('counts a host change of one drive in that drive\'s version', function (): void {
    ['drive' => $drive, 'node' => $node] = Revocation::inheritedDocument();
    $before = Revocation::versions($node);

    app(AccessInvalidation::class)->changed(DriveRef::of($drive), 'host-policy');

    expect(Revocation::versions($node))->toEqual(new PermissionVersion(drive: $before->drive + 1, global: $before->global))
        ->and(permissionVersionRows()['drive:'.$node->drive_id])->toBe($before->drive + 1);
});

it('rolls the count back with the change it counts', function (): void {
    ['drive' => $drive, 'folder' => $folder, 'node' => $node] = Revocation::inheritedDocument();
    $before = Revocation::versions($node);

    expect(fn () => app(VaulterDatabase::class)->transaction(function () use ($drive, $folder): void {
        $drive->access()->grant($folder->id, new GrantInput(subject: Revocation::subject(3), role: RoleRegistry::READER));
        throw new RuntimeException('the caller failed after the grant');
    }))->toThrow(RuntimeException::class);

    expect(Revocation::versions($node))->toEqual($before);
});

it('creates the first row of a scope at version 1 and increments it afterwards', function (): void {
    $versions = app(PermissionVersions::class);

    app(VaulterDatabase::class)->transaction(function () use ($versions): void {
        $writer = new SinkWriter(app(VaulterDatabase::class));
        $versions->increment($writer, 'drive:fresh');
        $versions->increment($writer, 'drive:fresh');
        $versions->increment($writer, 'drive:fresh');
    });

    expect($versions->of('drive:fresh'))->toBe(3)
        ->and($versions->of('drive:never'))->toBe(0)
        ->and(PermissionVersions::key(null))->toBe('global')
        ->and(PermissionVersions::key('42'))->toBe('drive:42');
});

it('tells a pair that predates a change from a current one', function (): void {
    $current = new PermissionVersion(drive: 4, global: 2);

    expect(new PermissionVersion(drive: 3, global: 2)->olderThan($current))->toBeTrue()
        ->and(new PermissionVersion(drive: 4, global: 1)->olderThan($current))->toBeTrue()
        ->and(new PermissionVersion(drive: 4, global: 2)->olderThan($current))->toBeFalse()
        ->and(PermissionVersion::fromClaim(['drive' => 4, 'global' => 2]))->toEqual($current)
        ->and(PermissionVersion::fromClaim((object) ['drive' => 4, 'global' => 2]))->toEqual($current)
        ->and(PermissionVersion::fromClaim(['drive' => '4', 'global' => 2]))->toBeNull()
        ->and(PermissionVersion::fromClaim(['drive' => 4]))->toBeNull()
        ->and(PermissionVersion::fromClaim(['drive' => 4, 'global' => 2, 'node' => 1]))->toBeNull()
        ->and(PermissionVersion::fromClaim(7))->toBeNull();
});
