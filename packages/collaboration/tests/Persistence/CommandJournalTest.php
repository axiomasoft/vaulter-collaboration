<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Vaulter\Collaboration\Persistence\CommandActor;
use Vaulter\Collaboration\Persistence\CommandJournal;
use Vaulter\Collaboration\Persistence\RoomWriteConflict;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Collaboration\Persistence\UpdateLog;
use Vaulter\Collaboration\RoomOwnership;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Revocation;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;
use Vaulter\ValueObjects\Access\Actor;

it('retains a running intent on stale base and atomically commits bytes and one receipt on retry', function (): void {
    Hub::configure();
    $node = Hub::document();
    $db = app(VaulterDatabase::class);
    $db->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $owner = (string) Str::uuid();
    $db->transaction(function () use ($node, $owner): void {
        $locked = app(CollaborativeState::class)->lock($node->getKey());
        app(RoomOwnership::class)->selectProfile($locked, strict: true);
        app(RoomOwnership::class)->acquire($locked, $owner);
    });
    $aggregate = Hub::aggregate($node);
    $update = static fn (string $payload, ?int $seed = null): UpdateEnvelope => new UpdateEnvelope($aggregate->collab_epoch, (string) Str::uuid(), $payload, hash('sha256', $payload), 'server', $seed);
    $log = app(UpdateLog::class);
    $log->appendFenced($node->getKey(), $update('seed', $aggregate->state_version), $owner, 1, 0, static fn (): null => null);
    $scope = new CommandActor(Actor::user(AccessTestHelpers::user())->ref(), null, 'test', 'writer', (string) $node->drive_id, (string) $node->getKey());
    $journal = app(CommandJournal::class);
    $proposal = (string) Str::uuid();
    $digest = hash('sha256', 'proposal');
    $register = fn () => $journal->register($scope, 'A42', $proposal, $digest, 0, 1, 1, ['atomic_effects' => []]);
    $running = $register();
    expect($register())->toBe($running);
    $log->appendFenced($node->getKey(), $update('human'), $owner, 1, 1, static fn (): null => null);

    $prepared = $update('agent');
    $settle = fn (int $base, int $fence) => $journal->settle($running['id'], $owner, $fence, 0, $base, $running['fingerprint'], [$prepared], ['blocks' => []]);
    $tables = app(DatabaseOptions::class);
    $outbox = DB::table($tables->table('outbox'))->count();
    expect(fn () => $settle(1, 1))->toThrow(RoomWriteConflict::class, 'base_moved')
        ->and($journal->status($scope, 'A42')['state'])->toBe('running');
    $request = [
        'kind' => 'commit', 'id' => $running['id'], 'fingerprint' => $running['fingerprint'],
        'generation' => 0, 'owner_id' => $owner, 'owner_fence' => 1, 'base_seq' => 2,
        'updates' => [['update_id' => $prepared->updateId, 'payload' => base64_encode($prepared->payload), 'sha256' => $prepared->sha256()]],
    ];
    Hub::call('commands/settle', $request + ['evidence' => ['invalid']], null)->assertUnprocessable();
    $evidence = ['ranges' => [['window' => ' exact text ']]];
    $accepted = Hub::call('commands/settle', $request + ['evidence' => $evidence], null)->assertOk()->json();
    expect($accepted)->toMatchArray(['state' => 'committed', 'base_seq' => 2, 'from_seq' => 3, 'to_seq' => 3])
        ->and($settle(2, 9))->toBe($accepted)
        ->and($register())->toBe($accepted)
        ->and($journal->evidence($scope, $accepted['receipt_id'])['evidence'])->toBe($evidence)
        ->and($log->snapshot($node->getKey(), 0)->tail[2]['sha256'])->toBe($prepared->sha256())
        ->and(DB::table($tables->table('outbox'))->count())->toBe($outbox + 1);
});

it('terminally rejects an intent after Edit is revoked and refuses replay after View is revoked', function (): void {
    Hub::configure();
    ['drive' => $drive, 'folder' => $folder, 'grant' => $grant, 'node' => $node] = Revocation::inheritedDocument();
    $reader = $drive->access()->grant($node->getKey(), new GrantInput(subject: Revocation::subject(), role: RoleRegistry::READER));
    $db = app(VaulterDatabase::class);
    $db->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $owner = (string) Str::uuid();
    $db->transaction(function () use ($node, $owner): void {
        $doc = app(CollaborativeState::class)->lock($node->getKey());
        $rooms = app(RoomOwnership::class);
        $rooms->selectProfile($doc, strict: true);
        $rooms->acquire($doc, $owner);
    });
    $scope = new CommandActor(Actor::user(AccessTestHelpers::user())->ref(), null, 'test', 'writer', (string) $node->drive_id, (string) $node->getKey());
    $journal = app(CommandJournal::class);
    $registered = $journal->register($scope, 'A42', (string) Str::uuid(), hash('sha256', 'proposal'), 0, 1, 0, ['atomic_effects' => []]);
    $drive->access()->revoke($folder->id, $grant->id);

    $result = $journal->settle($registered['id'], $owner, 1, 0, 0, $registered['fingerprint'], [], []);
    expect($result)->toMatchArray(['state' => 'rejected', 'rejection_code' => 'edit_revoked', 'receipt_id' => null])
        ->and($journal->status($scope, 'A42'))->toBe($result)
        ->and(app(UpdateLog::class)->snapshot($node->getKey(), 0)->headSeq)->toBe(0);

    $drive->access()->revoke($node->getKey(), $reader->id);
    expect(fn () => $journal->status($scope, 'A42'))->toThrow(NodeNotFoundException::class);
});

it('leaves a command running when its stored authority is malformed', function (): void {
    Hub::configure();
    $node = Hub::document();
    $db = app(VaulterDatabase::class);
    $db->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $owner = (string) Str::uuid();
    $db->transaction(function () use ($node, $owner): void {
        $doc = app(CollaborativeState::class)->lock($node->getKey());
        $rooms = app(RoomOwnership::class);
        $rooms->selectProfile($doc, strict: true);
        $rooms->acquire($doc, $owner);
    });
    $scope = new CommandActor(Actor::user(AccessTestHelpers::user())->ref(), null, 'test', 'writer', (string) $node->drive_id, (string) $node->getKey());
    $journal = app(CommandJournal::class);
    $command = $journal->register($scope, 'A42', (string) Str::uuid(), hash('sha256', 'proposal'), 0, 1, 0, ['atomic_effects' => []]);
    $commands = DB::table(app(DatabaseOptions::class)->table('collaboration_commands'));
    $commands->where('id', $command['id'])->update(['intent' => json_encode([
        'principal_type' => ['invalid'], 'principal_id' => $scope->principal->id,
        'tenant' => $scope->tenant, 'drive_id' => $scope->driveId, 'operation' => ['atomic_effects' => []],
    ], JSON_THROW_ON_ERROR)]);

    expect(fn () => $journal->settle($command['id'], $owner, 1, 0, 0, $command['fingerprint'], [], []))
        ->toThrow(LogicException::class, 'Invalid stored collaboration command scope.')
        ->and($journal->status($scope, 'A42'))->toBe($command);
});

it('rejects a full discovery batch of trashed documents and finds the next healthy target', function (): void {
    Hub::configure();
    $db = app(VaulterDatabase::class);
    $journal = app(CommandJournal::class);
    $actor = Actor::user(AccessTestHelpers::user())->ref();
    $proposal = (string) Str::uuid();
    $digest = hash('sha256', 'proposal');
    $trashedCommands = [];

    $this->freezeTime();
    for ($index = 0; $index <= 16; $index++) {
        $node = Hub::document();
        $aggregate = Hub::aggregate($node);
        $db->write(fn () => $aggregate->forceFill(['write_mode' => 'journal'])->save());
        $db->transaction(function () use ($node): void {
            $doc = app(CollaborativeState::class)->lock($node->getKey());
            app(RoomOwnership::class)->selectProfile($doc, strict: true);
        });
        $scope = new CommandActor($actor, null, 'test', 'writer', (string) $node->drive_id, (string) $node->getKey());
        $command = $journal->register($scope, 'A42', $proposal, $digest, 0, 1, 0, ['atomic_effects' => []]);
        if ($index < 16) {
            $trashedDrive = Vaulter::drive($node->storage()->firstOrFail())->asSystem('journal test');
            $trashedDrive->nodes()->trash($node->id);
            $trashedNode = $node->id;
            $trashedCommand = $command;
            $trashedCommands[] = $command['id'];
        }
        $this->travel(1)->seconds();
    }

    $target = ['document' => (string) $aggregate->getKey(), 'generation' => 0];
    expect($journal->targets())->toBe([$target])
        ->and($journal->targets())->toBe([$target]);

    $commands = DB::table(app(DatabaseOptions::class)->table('collaboration_commands'));
    expect($commands->whereIn('id', $trashedCommands)->whereNotNull('document_id')->whereNotNull('finalized_at')
        ->where('state', 'rejected')->where('rejection_code', 'resource_unavailable')->count())->toBe(16);

    $trashedDrive->trash()->restore($trashedNode);
    $replay = $journal->settle($trashedCommand['id'], (string) Str::uuid(), 1, 0, 0, $trashedCommand['fingerprint'], [], []);
    expect($replay)->toMatchArray(['state' => 'rejected', 'rejection_code' => 'resource_unavailable', 'receipt_id' => null])
        ->and($journal->targets())->toBe([$target]);
});
