<?php

declare(strict_types=1);

use Firebase\JWT\JWT;
use Illuminate\Support\Carbon;
use Vaulter\Collaboration\CollaborationCall;
use Vaulter\Collaboration\CollaborationCallResolver;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Exceptions\CollaborationConfigException;
use Vaulter\Collaboration\RoomTokens;
use Vaulter\Collaboration\Tests\Collaboration\HubTestHelpers as Hub;
use Vaulter\Collaboration\Tests\Support\Revocation;
use Vaulter\Testing\Fixtures\TestUser;
use Vaulter\ValueObjects\Access\ActorRef;

const CLAIMS_KEY_A = 'rotation-key-a-0123456789-0123456789';
const CLAIMS_KEY_B = 'rotation-key-b-0123456789-0123456789';

beforeEach(function (): void {
    Hub::configure();
    ['node' => $this->node] = Revocation::inheritedDocument();
    $this->verify = static fn (?string $token): ?CollaborationCall => app(CollaborationCallResolver::class)->verifyToken($token);
});

/** @param array<string, mixed> $claims overrides; a null value removes the claim */
function claimsToken(object $test, array $claims = [], string $key = Hub::JWT_SECRET, string $alg = 'HS256', ?string $kid = Hub::JWT_KID, int $epoch = 0): string
{
    $now = now()->getTimestamp();
    $base = [
        'iss' => Hub::ISSUER, 'aud' => CollaborationOptions::JWT_AUDIENCE, 'sub' => '1', 'sub_type' => (new TestUser)->getMorphClass(),
        'protocol' => CollaborationOptions::JWT_PROTOCOL, 'state_format' => 'yjs-update-v1',
        'document_id' => (string) $test->node->getKey(), 'drive_id' => (string) $test->node->drive_id, 'tenant' => null,
        'generation' => $epoch, 'schema_version' => 1, 'scope' => 'write', 'permissions_version' => ['drive' => 0, 'global' => 0],
        'room' => Hub::room($test->node, $epoch), 'iat' => $now, 'nbf' => $now, 'exp' => $now + 300, 'jti' => 'jti-claims',
    ];
    $payload = array_filter([...$base, ...$claims], static fn (mixed $value, string $name): bool => $value !== null || $name === 'tenant', ARRAY_FILTER_USE_BOTH);
    foreach ($claims as $name => $value) {
        if ($value === null && $name !== 'tenant') {
            unset($payload[$name]);
        }
    }

    return JWT::encode($payload, $key, $alg, $kid);
}

/** The token with another HMAC algorithm in the header, signed with the same secret by hand. */
function forgedToken(string $token, string $alg): string
{
    $parts = explode('.', $token);
    $header = json_decode(base64_decode(strtr($parts[0], '-_', '+/')), true);
    $parts[0] = rtrim(strtr(base64_encode((string) json_encode([...$header, 'alg' => $alg])), '+/', '-_'), '=');
    $hash = $alg === 'HS512' ? 'sha512' : 'sha384';

    return $parts[0].'.'.$parts[1].'.'.rtrim(strtr(base64_encode(hash_hmac($hash, $parts[0].'.'.$parts[1], Hub::JWT_SECRET, true)), '+/', '-_'), '=');
}

function withTwoKeys(string $active = 'b', array $keys = ['a' => CLAIMS_KEY_A, 'b' => CLAIMS_KEY_B]): void
{
    config()->set('vaulter-collaboration.hub.jwt_keys', $keys);
    config()->set('vaulter-collaboration.hub.jwt_active_kid', $active);
}

it('mints iss, aud, nbf = iat, protocol yjs/2 and a kid header with the existing claims untouched', function (): void {
    $minted = app(RoomTokens::class)->mint(new ActorRef(type: (new TestUser)->getMorphClass(), id: '1'), (string) $this->node->getKey(), (string) $this->node->drive_id, null, 0, 1, true, 'yjs', 'yjs-update-v1', now()->getTimestamp() + 300);
    $claims = Revocation::claims($minted['token']);
    $header = json_decode(base64_decode(strtr(explode('.', $minted['token'])[0], '-_', '+/')), true);

    expect($header)->toMatchArray(['alg' => 'HS256', 'kid' => Hub::JWT_KID])
        ->and($claims)->toMatchArray(['iss' => Hub::ISSUER, 'aud' => 'vaulter-collaboration-hub', 'protocol' => 'yjs/2', 'state_format' => 'yjs-update-v1', 'sub_type' => (new TestUser)->getMorphClass()])
        ->and($claims['nbf'])->toBe($claims['iat'])
        ->and($claims)->toHaveKeys(['sub', 'document_id', 'drive_id', 'tenant', 'generation', 'schema_version', 'scope', 'permissions_version', 'room', 'exp', 'jti'])
        ->and(($this->verify)($minted['token']))->toBeInstanceOf(CollaborationCall::class)
        ->and(($this->verify)($minted['token'])->protocol)->toBe('yjs');
});

it('refuses to mint without a usable key set, an issuer or the yjs binding protocol', function (): void {
    $mint = fn (string $protocol = 'yjs') => app(RoomTokens::class)->mint(new ActorRef(type: (new TestUser)->getMorphClass(), id: '1'), (string) $this->node->getKey(), (string) $this->node->drive_id, null, 0, 1, true, $protocol, 'yjs-update-v1', now()->getTimestamp() + 300);

    expect(fn () => $mint('other'))->toThrow(InvalidArgumentException::class);

    config()->set('vaulter-collaboration.hub.jwt_active_kid', 'gone');
    expect($mint)->toThrow(CollaborationConfigException::class);

    Hub::configure();
    config()->set('vaulter-collaboration.hub.jwt_keys', [Hub::JWT_KID => 'short']);
    expect($mint)->toThrow(CollaborationConfigException::class);

    Hub::configure();
    config()->set('vaulter-collaboration.hub.issuer', '');
    config()->set('app.url', '');
    expect($mint)->toThrow(CollaborationConfigException::class);
});

it('accepts a valid token and refuses every wrong header, signature, issuer or audience', function (): void {
    expect(($this->verify)(claimsToken($this)))->toBeInstanceOf(CollaborationCall::class);

    $none = rtrim(strtr(base64_encode((string) json_encode(['alg' => 'none', 'typ' => 'JWT', 'kid' => Hub::JWT_KID])), '+/', '-_'), '=').'.'.explode('.', claimsToken($this))[1].'.';

    foreach ([
        'alg none' => $none,
        'HS512 with the same secret' => forgedToken(claimsToken($this), 'HS512'),
        'HS384 with the same secret' => forgedToken(claimsToken($this), 'HS384'),
        'unknown kid' => claimsToken($this, kid: 'other'),
        'missing kid' => claimsToken($this, kid: null),
        'wrong secret for the kid' => claimsToken($this, key: CLAIMS_KEY_A),
        'tampered' => claimsToken($this).'x',
        'wrong issuer' => claimsToken($this, ['iss' => 'https://evil.test']),
        'issuer with a trailing slash' => claimsToken($this, ['iss' => Hub::ISSUER.'/']),
        'wrong audience' => claimsToken($this, ['aud' => 'someone-else']),
        'audience list' => claimsToken($this, ['aud' => ['vaulter-collaboration-hub']]),
        'garbage' => 'not.a.jwt',
    ] as $label => $token) {
        expect(($this->verify)($token))->toBeNull($label);
    }
    expect(($this->verify)(null))->toBeNull()->and(($this->verify)(''))->toBeNull();
});

it('refuses a token carrying a key reference header', function (string $header): void {
    $parts = explode('.', claimsToken($this));
    $decoded = json_decode(base64_decode(strtr($parts[0], '-_', '+/')), true);
    $parts[0] = rtrim(strtr(base64_encode((string) json_encode([...$decoded, $header => 'https://evil.test/keys'])), '+/', '-_'), '=');
    // Re-sign so that only the reference header differs.
    $signature = rtrim(strtr(base64_encode(hash_hmac('sha256', $parts[0].'.'.$parts[1], Hub::JWT_SECRET, true)), '+/', '-_'), '=');

    expect(($this->verify)($parts[0].'.'.$parts[1].'.'.$signature))->toBeNull();
})->with(['jku', 'x5u', 'jwk', 'x5c', 'crit']);

it('requires every claim, exactly typed', function (string $claim): void {
    expect(($this->verify)(claimsToken($this, [$claim => null])))->toBeNull();
})->with(['iss', 'aud', 'nbf', 'iat', 'exp', 'jti', 'protocol', 'state_format', 'sub_type', 'sub', 'room', 'document_id', 'drive_id', 'generation', 'schema_version', 'scope', 'permissions_version']);

it('refuses a missing tenant claim and wrong or malformed values', function (): void {
    foreach ([
        'wrong protocol' => ['protocol' => 'yjs/3'],
        'bare protocol' => ['protocol' => 'yjs'],
        'wrong state format' => ['state_format' => ''],
        'numeric state format' => ['state_format' => 7],
        'system subject' => ['sub_type' => 'vaulter:system'],
        'empty jti' => ['jti' => ''],
        'string exp' => ['exp' => (string) (now()->getTimestamp() + 300)],
        'string nbf' => ['nbf' => (string) now()->getTimestamp()],
        'string iat' => ['iat' => (string) now()->getTimestamp()],
        'iat after nbf' => ['iat' => now()->getTimestamp() + 5],
        'nbf not before exp' => ['nbf' => now()->getTimestamp() + 300],
        'future nbf beyond the leeway' => ['nbf' => now()->getTimestamp() + 31, 'iat' => now()->getTimestamp() + 31, 'exp' => now()->getTimestamp() + 400],
        'bad scope' => ['scope' => 'admin'],
        'bad generation' => ['generation' => '0'],
        'bad schema' => ['schema_version' => 0],
        'bad tenant' => ['tenant' => 5],
        'bad permissions version' => ['permissions_version' => ['drive' => 'x', 'global' => 0]],
        'room of another document' => ['document_id' => '999999'],
    ] as $label => $claims) {
        expect(($this->verify)(claimsToken($this, $claims)))->toBeNull($label);
    }

    $parts = explode('.', claimsToken($this));
    $payload = json_decode(base64_decode(strtr($parts[1], '-_', '+/')), true);
    unset($payload['tenant']);

    expect(($this->verify)(JWT::encode($payload, Hub::JWT_SECRET, 'HS256', Hub::JWT_KID)))->toBeNull();
});

it('accepts a future nbf within the leeway and refuses it beyond', function (): void {
    $now = now()->getTimestamp();

    expect(($this->verify)(claimsToken($this, ['nbf' => $now + 30, 'iat' => $now + 30, 'exp' => $now + 330])))->toBeInstanceOf(CollaborationCall::class)
        ->and(($this->verify)(claimsToken($this, ['nbf' => $now + 31, 'iat' => $now + 31, 'exp' => $now + 331])))->toBeNull();
});

it('keeps the exact exp plus skew boundary without extra grace and restores the JWT globals', function (int $skew, int $exp, bool $accepted): void {
    $oldNow = Carbon::getTestNow();
    [$leeway, $timestamp] = [JWT::$leeway, JWT::$timestamp];
    try {
        Carbon::setTestNow(Carbon::createFromTimestamp(1000));
        config()->set('vaulter-collaboration.hub.clock_skew', $skew);
        $token = claimsToken($this, ['iat' => 900, 'nbf' => 900, 'exp' => $exp]);

        expect(($this->verify)($token) instanceof CollaborationCall)->toBe($accepted)
            ->and(JWT::$leeway)->toBe($leeway)->and(JWT::$timestamp)->toBe($timestamp);
    } finally {
        Carbon::setTestNow($oldNow);
        [JWT::$leeway, JWT::$timestamp] = [$leeway, $timestamp];
    }
})->with([[30, 971, true], [30, 970, false], [30, 969, false], [0, 1001, true], [0, 1000, false], [0, 999, false]]);

it('fails closed and restores the JWT globals on a skew outside 0..30', function (int $skew): void {
    [$leeway, $timestamp] = [JWT::$leeway, JWT::$timestamp];
    config()->set('vaulter-collaboration.hub.clock_skew', $skew);

    expect(($this->verify)(claimsToken($this)))->toBeNull()
        ->and(JWT::$leeway)->toBe($leeway)->and(JWT::$timestamp)->toBe($timestamp);
})->with([31, 60, -1]);

it('overlaps keys on rotation: the old kid verifies, a renewal signs with the new one, removal ends the old', function (): void {
    $old = claimsToken($this, key: CLAIMS_KEY_A, kid: 'a');
    withTwoKeys('b');

    expect(($this->verify)($old))->toBeInstanceOf(CollaborationCall::class)
        ->and(($this->verify)(claimsToken($this, key: CLAIMS_KEY_B, kid: 'b')))->toBeInstanceOf(CollaborationCall::class);

    $renewed = Hub::call('renew', ['room' => Hub::room($this->node)], $old)->assertOk()->json('token');
    $header = json_decode(base64_decode(strtr(explode('.', $renewed)[0], '-_', '+/')), true);

    expect($header['kid'])->toBe('b');

    // The key A leaves the set: its tokens fail on every call, the renewed one keeps working.
    withTwoKeys('b', ['b' => CLAIMS_KEY_B]);
    $body = ['room' => Hub::room($this->node)];

    expect(($this->verify)($old))->toBeNull()
        ->and(($this->verify)($renewed))->toBeInstanceOf(CollaborationCall::class);
    foreach (['authenticate', 'load', 'append', 'renew'] as $endpoint) {
        expect(Hub::call($endpoint, $body, $old)->status())->toBe(401, $endpoint);
    }
    expect(Hub::call('recheck', ['connections' => [['id' => 'c1', 'token' => $old]]], Hub::token($this->node))->json('results.0.access') ?? Hub::call('recheck', ['connections' => [['id' => 'c1', 'token' => $old]]], Hub::token($this->node))->json('0.access'))->not->toBe('write');
});

it('refuses a token while the key set is unusable and never trusts a key equal to the webhook secret', function (): void {
    $token = claimsToken($this);
    config()->set('vaulter-collaboration.hub.jwt_keys', [Hub::JWT_KID => Hub::JWT_SECRET, 'old' => Hub::WEBHOOK_SECRET.str_repeat('x', 32)]);
    expect(($this->verify)($token))->toBeInstanceOf(CollaborationCall::class);

    config()->set('vaulter-collaboration.hub.jwt_keys', [Hub::JWT_KID => Hub::JWT_SECRET, 'old' => 'short']);
    expect(($this->verify)($token))->toBeNull();

    config()->set('vaulter-collaboration.hub.jwt_keys', [Hub::JWT_KID => Hub::JWT_SECRET]);
    config()->set('vaulter-collaboration.hub.webhook_secret', Hub::JWT_SECRET);
    expect(($this->verify)($token))->toBeNull();
});

it('keeps the P3.7 binding: a wrong or missing state_format is denied even with valid crypto, issuer and audience', function (): void {
    $body = ['room' => Hub::room($this->node)];

    Hub::call('authenticate', $body, claimsToken($this))->assertOk();
    Hub::call('authenticate', $body, claimsToken($this, ['state_format' => 'other-format']))->assertStatus(409);
    Hub::call('authenticate', $body, claimsToken($this, ['state_format' => null]))->assertUnauthorized();
    Hub::call('authenticate', $body, claimsToken($this, ['sub_type' => null]))->assertUnauthorized();
});

it('reads the issuer from the server configuration, never from the request host', function (): void {
    $token = claimsToken($this);
    config()->set('vaulter-collaboration.hub.issuer');
    config()->set('app.url', 'https://other.test');

    expect(($this->verify)($token))->toBeNull();

    config()->set('app.url', Hub::ISSUER);

    expect(($this->verify)($token))->toBeInstanceOf(CollaborationCall::class);
});
