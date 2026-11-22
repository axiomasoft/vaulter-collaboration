<?php

declare(strict_types=1);

use Illuminate\Config\Repository;
use Packman\Config\Data\SecretRef;
use Packman\Config\Exceptions\InvalidConfiguration;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Data\RoomRef;
use Vaulter\Documents\Configuration\DocumentsOptions;

/** @param array<string, mixed> $values the `vaulter-collaboration` root, plus `documents` for the `vaulter-documents` root */
function config_of(array $values = [], array $documents = []): CollaborationOptions
{
    $repository = new Repository(['vaulter-collaboration' => $values, 'vaulter-documents' => $documents]);

    return CollaborationOptions::fromArray(($repository)->get('vaulter-collaboration', []))->withContext(DocumentsOptions::fromArray(($repository)->get('vaulter-documents', [])), ($repository)->get('app.url'));
}

it('reads the shipped defaults of the vaulter-collaboration root', function (): void {
    $config = config_of(require __DIR__.'/../../config/vaulter-collaboration.php');

    expect($config->hubUrl())->toBe('ws://localhost:1234')
        ->and($config->hubTokenTtl())->toBe(300)
        ->and($config->hubClockSkew())->toBe(30)
        ->and($config->controlTransport())->toBe('none')
        ->and($config->controlRedisConnection())->toBe('default')
        ->and($config->controlHttpUrls())->toBe([])
        ->and($config->controlHttpTimeout())->toBe(2)
        ->and($config->hubTimestampTolerance())->toBe(300)
        ->and($config->maxStateBytes())->toBe(16777216)
        ->and($config->channelPrefix())->toBe('vaulter.documents');
});

it('reads the key set, the active kid, the issuer and the webhook secret of the hub, leaving malformed entries out', function (): void {
    $config = config_of(['hub' => ['jwt_keys' => ['a' => 'key-a', 'b' => '', 'c' => 5, '' => 'x'], 'jwt_active_kid' => 'a', 'webhook_secret' => 'webhook', 'token_ttl' => 120, 'issuer' => 'https://issuer.test']]);

    expect(array_map(static fn (SecretRef $ref): string => $ref->reveal(), $config->hubJwtKeys()))->toBe(['a' => 'key-a'])
        ->and($config->hubJwtActiveKid())->toBe('a')
        ->and($config->hubJwtSigningKey()?->reveal())->toBe('key-a')
        ->and($config->hubIssuer())->toBe('https://issuer.test')
        ->and($config->hubWebhookSecret()?->reveal())->toBe('webhook')
        ->and($config->hubTokenTtl())->toBe(120)
        ->and(config_of(['hub' => ['jwt_keys' => [], 'jwt_active_kid' => '', 'webhook_secret' => 5]])->hubJwtActiveKid())->toBeNull()
        ->and(config_of(['hub' => ['jwt_keys' => [], 'jwt_active_kid' => 'a']])->hubJwtSigningKey())->toBeNull()
        ->and(config_of(['hub' => ['webhook_secret' => 5]])->hubWebhookSecret())->toBeNull();
});

it('redacts JWT signing keys and webhook secrets from print_r and string casts via SecretRef', function (): void {
    $rawJwtSecret = 'super-secret-jwt-key-0123456789-abcdef';
    $rawWebhookSecret = 'super-secret-webhook-hmac-key-987654';
    $options = config_of([
        'hub' => [
            'jwt_keys' => ['primary' => $rawJwtSecret],
            'jwt_active_kid' => 'primary',
            'webhook_secret' => $rawWebhookSecret,
        ],
    ]);

    $dumped = print_r($options, true);

    expect($dumped)->not->toContain($rawJwtSecret)
        ->and($dumped)->not->toContain($rawWebhookSecret)
        ->and((string) $options->hubJwtSigningKey())->toBe('[redacted]')
        ->and((string) $options->hubWebhookSecret())->toBe('[redacted]');
});

it('takes the issuer from app.url unless hub.issuer is set, and never from empty values', function (): void {
    $repository = new Repository(['app' => ['url' => 'https://app.test'], 'vaulter-collaboration' => ['hub' => ['issuer' => ' ']], 'vaulter-documents' => []]);
    $config = CollaborationOptions::fromArray(($repository)->get('vaulter-collaboration', []))->withContext(DocumentsOptions::fromArray(($repository)->get('vaulter-documents', [])), ($repository)->get('app.url'));

    expect($config->hubIssuer())->toBe('https://app.test')
        ->and(config_of()->hubIssuer())->toBeNull();
});

it('structurally validates the clock skew to 0..30 seconds with default 30 and no clamping', function (): void {
    expect(config_of(['hub' => ['clock_skew' => 0]])->hubClockSkew())->toBe(0)
        ->and(config_of(['hub' => ['clock_skew' => 30]])->hubClockSkew())->toBe(30)
        ->and(config_of()->hubClockSkew())->toBe(30);

    foreach ([31, 60, -1] as $skew) {
        expect(fn (): int => config_of(['hub' => ['clock_skew' => $skew]])->hubClockSkew())->toThrow(InvalidConfiguration::class, 'between 0 and 30');
    }
});

it('round trips room identities under the channel prefix of the documents', function (): void {
    $config = config_of(documents: ['broadcast' => ['channel_prefix' => 'host.docs']]);

    $room = $config->room('01DRIVE', '01ABC', 3);

    expect($room)->toBe('host.docs.01DRIVE.01ABC.3')
        ->and($config->parseRoom($room))->toEqual(new RoomRef(driveId: '01DRIVE', nodeId: '01ABC', epoch: 3));
});

it('parses only room names it issues', function (string $room): void {
    expect(config_of(documents: ['broadcast' => ['channel_prefix' => 'host.docs']])->parseRoom($room))->toBeNull();
})->with([
    'foreign prefix' => ['foreign.room.1.2.0'],
    'no epoch (0.2 room)' => ['host.docs.42'],
    'missing drive' => ['host.docs.42.0'],
    'extra segment' => ['host.docs.1.2.3.4'],
    'empty node' => ['host.docs.1..0'],
    'negative epoch' => ['host.docs.1.2.-1'],
    'padded epoch' => ['host.docs.1.2.01'],
    'non-numeric epoch' => ['host.docs.1.2.x'],
]);

it('refuses the removed reverb driver and a token ttl above five minutes', function (): void {
    $ttl = static fn (int $seconds): CollaborationOptions => config_of(['hub' => ['token_ttl' => $seconds]]);

    expect(fn (): int => $ttl(301)->hubTokenTtl())->toThrow(InvalidConfiguration::class)
        ->and(fn (): int => $ttl(0)->hubTokenTtl())->toThrow(InvalidConfiguration::class)
        ->and($ttl(300)->hubTokenTtl())->toBe(300)
        ->and(config_of()->maxStateBytes())->toBe(16777216)
        ->and(config_of(['max_state_bytes' => 0])->maxStateBytes())->toBe(16777216)
        ->and(config_of(['max_state_bytes' => 8])->maxStateBytes())->toBe(8);
});

it('keeps a timestamp tolerance of at least one second', function (): void {
    expect(config_of(['hub' => ['timestamp_tolerance' => 0]])->hubTimestampTolerance())->toBe(1)
        ->and(config_of()->hubTimestampTolerance())->toBe(300);
});
