<?php

declare(strict_types=1);

use Firebase\JWT\JWT;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Packman\Config\Exceptions\InvalidConfiguration;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Revocation;
use Vaulter\Configuration\DatabaseOptions;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Testing\Access\AccessTestHelpers;

/**
 * POST /v1/collaboration/hub/renew: the hub renews a connection's token before it expires. The rights
 * are checked now, so a renewal never extends authority the subject lost: without View it is refused, without Edit it
 * is read-only, and the new token expires token_ttl from now while the old one keeps its exp.
 */
beforeEach(function (): void {
    Hub::configure();
    ['drive' => $this->drive, 'folder' => $this->folder, 'grant' => $this->grant, 'node' => $this->node] = Revocation::inheritedDocument();
});

function revocationRenew(object $test, string $token, ?string $room = null): TestResponse
{
    return Hub::call('renew', ['room' => $room ?? Hub::room($test->node)], $token);
}

it('renews a session whose rights still hold with a new exp from now, a new jti and the current versions', function (): void {
    $old = Hub::token($this->node);
    $oldClaims = Revocation::claims($old);
    $this->travel(120)->seconds();
    $this->drive->access()->grant($this->folder->id, new GrantInput(subject: Revocation::subject(9), role: RoleRegistry::READER));

    $response = revocationRenew($this, $old)->assertOk()
        ->assertJsonPath('scope', 'write')
        ->assertJsonPath('mode', 'rw')
        ->assertJsonPath('room', Hub::room($this->node))
        ->assertJsonPath('generation', 0);
    $claims = Revocation::claims($response->json('token'));

    expect($claims['exp'])->toBe(now()->getTimestamp() + 300)
        ->and($response->json('exp'))->toBe($claims['exp'])
        ->and($claims['exp'])->toBeGreaterThan($oldClaims['exp'])
        ->and($claims['jti'])->not->toBe($oldClaims['jti'])
        ->and($response->json('jti'))->toBe($claims['jti'])
        ->and($claims['permissions_version'])->toBe(Revocation::versions($this->node)->toClaim())
        ->and($claims['permissions_version']['drive'])->toBeGreaterThan($oldClaims['permissions_version']['drive'])
        ->and(Revocation::claims($old)['exp'])->toBe($oldClaims['exp']);
});

it('refuses to renew a session whose subject lost every right', function (): void {
    $token = Hub::token($this->node);
    $this->drive->access()->revoke($this->folder->id, $this->grant);

    revocationRenew($this, $token)->assertNotFound()->assertJsonPath('code', 'node_not_found');
});

it('renews a writer who lost Edit but kept View read-only', function (): void {
    $token = Hub::token($this->node);
    AccessTestHelpers::grant($this->node, RoleRegistry::READER);
    $this->drive->access()->revoke($this->folder->id, $this->grant);

    $response = revocationRenew($this, $token)->assertOk()->assertJsonPath('scope', 'read')->assertJsonPath('mode', 'ro');

    expect(Revocation::claims($response->json('token'))['scope'])->toBe('read');
});

it('never widens a read-only token, whatever the subject may do now', function (): void {
    revocationRenew($this, Hub::token($this->node, mode: 'ro'))->assertOk()->assertJsonPath('scope', 'read');
});

it('renews read-only while the drive is archived', function (): void {
    $token = Hub::token($this->node);
    $this->drive->archive();

    revocationRenew($this, $token)->assertOk()->assertJsonPath('scope', 'read');
});

it('answers 404 for a document in the trash', function (): void {
    $token = Hub::token($this->node);
    $this->drive->nodes()->trash((string) $this->node->getKey());

    revocationRenew($this, $token)->assertNotFound()->assertJsonPath('code', 'node_not_found');
});

it('answers 409 when the document moved to another generation', function (): void {
    $token = Hub::token($this->node);
    $room = Hub::room($this->node);
    DB::table(app(DatabaseOptions::class)->table('documents'))->where('node_id', $this->node->getKey())->increment('collab_epoch');

    revocationRenew($this, $token, $room)->assertStatus(409)->assertJsonPath('code', 'collaboration_epoch_mismatch');
});

it('accepts a token within the clock skew of its exp and refuses one beyond it', function (): void {
    revocationRenew($this, Hub::token($this->node, claims: ['iat' => time() - 100, 'nbf' => time() - 100, 'exp' => time() - 10]))->assertOk();
    revocationRenew($this, Hub::token($this->node, claims: ['iat' => time() - 100, 'nbf' => time() - 100, 'exp' => time() - 31]))->assertUnauthorized();
});

it('refuses a body that names another room than the token', function (): void {
    ['node' => $other] = Revocation::inheritedDocument();

    revocationRenew($this, Hub::token($this->node), Hub::room($other))->assertForbidden();
});

it('keeps the exact production verifier skew boundary with fixed clocks', function (int $skew, int $exp, int $status): void {
    $oldNow = Carbon::getTestNow();
    $oldSkew = config('vaulter-collaboration.hub.clock_skew');
    [$leeway, $timestamp] = [JWT::$leeway, JWT::$timestamp];
    try {
        Carbon::setTestNow(Carbon::createFromTimestamp(1000));
        config()->set('vaulter-collaboration.hub.clock_skew', $skew);
        $token = Hub::token($this->node, claims: ['iat' => 900, 'nbf' => 900, 'exp' => $exp]);
        $response = revocationRenew($this, $token)->assertStatus($status);
        if ($status === 200) {
            expect($response->json('exp'))->toBe(1300)->and($response->json('token'))->not->toBe($token);
        } else {
            $response->assertJsonMissingPath('token');
        }
        expect(JWT::$leeway)->toBe($leeway)->and(JWT::$timestamp)->toBe($timestamp);
    } finally {
        Carbon::setTestNow($oldNow);
        config()->set('vaulter-collaboration.hub.clock_skew', $oldSkew);
        [JWT::$leeway, JWT::$timestamp] = [$leeway, $timestamp];
    }
})->with([[30, 990, 200], [30, 971, 200], [30, 970, 401], [30, 969, 401], [0, 1001, 200], [0, 1000, 401], [0, 999, 401], [0, 990, 401]]);

it('tightens the skew configuration bounds to zero through thirty without clamping', function (int $skew, bool $valid): void {
    expect(app(CollaborationOptions::class)->hubClockSkew())->toBe(30);
    config()->set('vaulter-collaboration.hub.clock_skew', $skew);
    $read = fn () => app(CollaborationOptions::class)->hubClockSkew();
    if ($valid) {
        expect($read())->toBe($skew);
    } else {
        expect($read)->toThrow(InvalidConfiguration::class);
    }
})->with([[0, true], [30, true], [31, false], [60, false], [-1, false], [61, false]]);

it('applies live View and the original Read ceiling even inside expiry skew', function (): void {
    $oldNow = Carbon::getTestNow();
    try {
        Carbon::setTestNow(Carbon::createFromTimestamp(1000));
        $token = Hub::token($this->node, mode: 'ro', claims: ['iat' => 900, 'nbf' => 900, 'exp' => 990]);
        revocationRenew($this, $token)->assertOk()->assertJsonPath('scope', 'read');
        revocationRenew($this, $token.'x')->assertUnauthorized();
        revocationRenew($this, Hub::token($this->node, claims: ['iat' => 900, 'exp' => 990, 'sub_type' => null]))->assertUnauthorized();
        $this->drive->access()->revoke($this->folder->id, $this->grant);
        revocationRenew($this, $token)->assertNotFound()->assertJsonMissingPath('token');
    } finally {
        Carbon::setTestNow($oldNow);
    }
});
