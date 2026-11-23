<?php

declare(strict_types=1);

use Illuminate\Support\Str;
use Vaulter\Collaboration\Persistence\RoomWriteConflict;
use Vaulter\Collaboration\RoomOwnership;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Concurrency\RaceFixtures;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Testing\Concurrency\ForkRace;

it('gives concurrent room owners one lease and fences the winner after handoff', function (): void {
    $db = app(VaulterDatabase::class);
    ForkRace::skipUnlessSupported($this, $db->connection()->getName());
    Hub::configure();
    $node = RaceFixtures::document();
    $nodeId = $node->getKey();
    $db->write(fn () => Hub::aggregate($node)->forceFill(['write_mode' => 'journal'])->save());
    $db->transaction(fn () => app(RoomOwnership::class)->selectProfile(app(CollaborativeState::class)->lock($nodeId), strict: true));
    $owners = [(string) Str::uuid(), (string) Str::uuid()];
    $attempt = static fn (string $owner): Closure => static fn (): array => RaceFixtures::attempt(static function () use ($nodeId, $owner): void {
        app(VaulterDatabase::class)->transaction(
            static fn () => app(RoomOwnership::class)->acquire(app(CollaborativeState::class)->lock($nodeId), $owner),
        );
    });
    $results = RaceFixtures::race(array_map($attempt, $owners));
    $outcomes = array_column($results, 'kind');
    expect($outcomes)->toEqualCanonicalizing(['committed', 'collaboration_room_conflict']);
    $winner = $owners[array_search('committed', $outcomes, strict: true)];
    $loser = $owners[array_search('collaboration_room_conflict', $outcomes, strict: true)];

    $db->transaction(function () use ($nodeId, $winner, $loser): void {
        $locked = app(CollaborativeState::class)->lock($nodeId);
        $rooms = app(RoomOwnership::class);
        $rooms->release($locked, $winner, 1);
        expect($rooms->acquire($locked, $loser)->ownerFence)->toBe(2)
            ->and(fn () => $rooms->renew($locked, $winner, 1))->toThrow(RoomWriteConflict::class, 'stale_owner');
    });
});
