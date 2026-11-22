<?php

declare(strict_types=1);

use Illuminate\Config\Repository;
use Packman\Config\Data\SecretRef;
use Packman\Config\Exceptions\InvalidConfiguration;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Security\HubUrlInvariant;
use Vaulter\Collaboration\Security\SecretsInvariant;
use Vaulter\Documents\Configuration\DocumentsOptions;

const SECRETS_KEY_A = 'key-a-0123456789-0123456789-0123456789';
const SECRETS_KEY_B = 'key-b-0123456789-0123456789-0123456789';

/** @param array<string, mixed> $keys the PHP array form; `$env` is the environment string form and wins */
function collaborationConfig(array $keys, ?string $active, ?string $webhook, ?string $env = null): CollaborationOptions
{
    $repository = new Repository(['vaulter-collaboration' => [
        'hub' => ['jwt_keys' => $env ?? $keys, 'jwt_active_kid' => $active, 'webhook_secret' => $webhook],
    ]]);

    return CollaborationOptions::fromArray(($repository)->get('vaulter-collaboration', []))->withContext(DocumentsOptions::fromArray(($repository)->get('vaulter-documents', [])), ($repository)->get('app.url'));
}

it('reports a missing, short, reused or unanchored JWT key set as the collaboration.secrets invariant', function (array $keys, ?string $active, ?string $webhook): void {
    $invariant = new SecretsInvariant(collaborationConfig($keys, $active, $webhook));

    expect($invariant->id())->toBe('collaboration.secrets')
        ->and($invariant->violation())->toContain('nonempty, different')
        ->and($invariant->violation())->not->toContain(SECRETS_KEY_A);
})->with([
    'nothing' => [[], null, null],
    'no webhook' => [['a' => SECRETS_KEY_A], 'a', null],
    'no keys' => [[], 'a', 'webhook'],
    'no active kid' => [['a' => SECRETS_KEY_A], null, 'webhook'],
    'unknown active kid' => [['a' => SECRETS_KEY_A], 'b', 'webhook'],
    'short key' => [['a' => 'short'], 'a', 'webhook'],
    'short old key' => [['a' => SECRETS_KEY_A, 'old' => 'short'], 'a', 'webhook'],
    'key equals webhook' => [['a' => SECRETS_KEY_A], 'a', SECRETS_KEY_A],
    'old key equals webhook' => [['a' => SECRETS_KEY_A, 'old' => SECRETS_KEY_B], 'a', SECRETS_KEY_B],
    'empty kid' => [['' => SECRETS_KEY_A], '', 'webhook'],
    'non-string secret' => [['a' => 5], 'a', 'webhook'],
]);

it('is silent for an overlapping key set with an active kid, all keys distinct from the webhook secret', function (): void {
    expect(new SecretsInvariant(collaborationConfig(['a' => SECRETS_KEY_A, 'b' => SECRETS_KEY_B], 'b', 'webhook'))->violation())->toBeNull();
});

it('requires a configured hub url to be wss and treats an empty url as no violation', function (?string $url, bool $secure): void {
    $repository = new Repository(['vaulter-collaboration' => ['hub' => ['url' => $url]]]);
    $invariant = new HubUrlInvariant(CollaborationOptions::fromArray(($repository)->get('vaulter-collaboration', []))->withContext(DocumentsOptions::fromArray(($repository)->get('vaulter-documents', [])), ($repository)->get('app.url')));

    expect($invariant->id())->toBe('collaboration.hub-url')
        ->and($invariant->violation() === null)->toBe($secure);
})->with([[null, true], ['', true], ['   ', true], ['ws://hub', false], ['http://hub', false], ['https://hub.example', false], ['wss://hub.example', true]]);

it('refuses an unusable JWT key set at boot in every environment, the old keys included', function (array $keys, ?string $active, ?string $webhook): void {
    expect(fn () => collaborationConfig($keys, $active, $webhook)->assertDistinctHubSecrets())->toThrow(InvalidConfiguration::class, 'unusable');
})->with([
    'webhook reuse' => [['a' => SECRETS_KEY_A], 'a', SECRETS_KEY_A],
    'old key reuses webhook' => [['a' => SECRETS_KEY_A, 'old' => SECRETS_KEY_B], 'a', SECRETS_KEY_B],
    'short old key' => [['a' => SECRETS_KEY_A, 'old' => 'short'], 'a', 'webhook'],
    'active not in set' => [['a' => SECRETS_KEY_A], 'b', 'webhook'],
    'active without keys' => [[], 'a', 'webhook'],
    'keys without active' => [['a' => SECRETS_KEY_A], null, 'webhook'],
]);

it('reads the environment string of kid:secret pairs and refuses a malformed or repeated pair', function (): void {
    $parse = static fn (string $value): CollaborationOptions => collaborationConfig([], 'b', 'webhook', $value);

    expect(array_map(static fn (SecretRef $ref): string => $ref->reveal(), $parse('a:'.SECRETS_KEY_A.',b:'.SECRETS_KEY_B)->hubJwtKeys()))->toBe(['a' => SECRETS_KEY_A, 'b' => SECRETS_KEY_B])
        ->and($parse('a:'.SECRETS_KEY_A.',b:'.SECRETS_KEY_B.',')->hubJwtKeysViolation())->toBeNull();

    foreach (['a:'.SECRETS_KEY_A.',b', 'b:'.SECRETS_KEY_B.',b:'.SECRETS_KEY_B, 'b:'.SECRETS_KEY_B.',a: '] as $value) {
        expect($parse($value)->hubJwtKeysViolation())->not->toBeNull();
    }
});

it('accepts a valid overlap set and a fully unset module at boot', function (): void {
    collaborationConfig(['a' => SECRETS_KEY_A, 'b' => SECRETS_KEY_B], 'b', 'webhook')->assertDistinctHubSecrets();
    collaborationConfig([], null, null)->assertDistinctHubSecrets();

    expect(true)->toBeTrue();
});
