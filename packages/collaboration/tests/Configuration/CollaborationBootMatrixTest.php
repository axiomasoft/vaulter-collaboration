<?php

declare(strict_types=1);

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Log;
use Packman\Config\Exceptions\InvalidConfiguration;
use Vaulter\Collaboration\Providers\CollaborationRegistrar;
use Vaulter\Collaboration\Tests\TestCase;
use Vaulter\Exceptions\Configuration\InsecureProductionConfiguration;

function bootJwt(): string
{
    return 'jwt-key-'.str_repeat('k', 32);
}

function bootCollaboration(string $environment, mixed $ttl, ?string $jwt, ?string $webhook, array $risks = []): void
{
    $app = app();
    $app['env'] = $environment;
    $app['config']->set('vaulter-collaboration.hub.token_ttl', $ttl);
    $app['config']->set('vaulter-collaboration.hub.jwt_keys', $jwt === null ? [] : ['k1' => $jwt]);
    $app['config']->set('vaulter-collaboration.hub.jwt_active_kid', $jwt === null ? null : 'k1');
    $app['config']->set('vaulter-collaboration.hub.issuer', 'https://vaulter.test');
    $app['config']->set('vaulter-collaboration.hub.webhook_secret', $webhook);
    $app['config']->set('vaulter.security.accepted_risks', $risks);
    (new CollaborationRegistrar)->register($app);
    (new CollaborationRegistrar)->boot($app);
}

it('rejects a structural token ttl outside 1..300 before any production-risk step, in every environment and under any risk reason', function (string $environment, int $ttl, array $risks): void {
    expect(fn () => bootCollaboration($environment, $ttl, bootJwt(), 'webhook-secret', $risks))->toThrow(InvalidConfiguration::class, 'token_ttl');
})->with(['production', 'testing'])->with([0, 301])->with([
    'no risk' => [[]],
    'accepted ttl id' => [['collaboration.token-ttl' => 'we know']],
]);

it('accepts the ttl bounds 1 and 300 with distinct secrets', function (string $environment, int $ttl): void {
    bootCollaboration($environment, $ttl, bootJwt(), 'webhook-secret');

    expect(true)->toBeTrue();
})->with(['production', 'testing'])->with([1, 300]);

it('allows missing secrets with a valid ttl at boot and always rejects equal nonempty secrets', function (string $environment): void {
    bootCollaboration($environment, 300, null, null);
    bootCollaboration($environment, 300, bootJwt(), null);

    expect(fn () => bootCollaboration($environment, 300, bootJwt(), bootJwt(), ['collaboration.secrets' => 'accepted']))->toThrow(InvalidConfiguration::class, 'unusable');
})->with(['production', 'testing']);

it('keeps the nonproduction missing-secret warning', function (): void {
    Log::spy();
    bootCollaboration('testing', 300, null, 'webhook-secret');

    Log::shouldHaveReceived('warning')->once()->with('[Vaulter] Collaboration requires a usable JWT key set and a different webhook secret.');
});

it('does not warn or throw at production boot for missing secrets: the process guard decides', function (): void {
    Log::spy();
    bootCollaboration('production', 300, null, 'webhook-secret');

    Log::shouldNotHaveReceived('warning');
});

/** Whole-application path: real providers, the real CommandStarting listener and the real invariant executor around a fake handler. */
final class CollaborationFakeHandler
{
    public static int $handled = 0;
}

/** @param array{env?: string, enabled?: bool, ttl?: int, jwt?: ?string, webhook?: ?string, risks?: array<string, string>} $settings */
function applyWholeAppSettings(array $settings): void
{
    $s = $settings + ['env' => 'production', 'enabled' => true, 'ttl' => 300, 'jwt' => null, 'webhook' => null, 'risks' => []];
    TestCase::$environmentOverride = $s['env'];
    TestCase::$configOverrides = [
        'vaulter.modules.collaboration' => $s['enabled'],
        'vaulter-collaboration.hub.url' => 'wss://hub.example.test',
        'vaulter-collaboration.hub.token_ttl' => $s['ttl'],
        'vaulter-collaboration.hub.jwt_keys' => $s['jwt'] === null ? [] : ['k1' => $s['jwt']],
        'vaulter-collaboration.hub.jwt_active_kid' => $s['jwt'] === null ? null : 'k1',
        'vaulter-collaboration.hub.issuer' => 'https://vaulter.test',
        'vaulter-collaboration.hub.webhook_secret' => $s['webhook'],
        // The unrelated drive permission-driver invariant is accepted with a control reason to isolate the collaboration scenario.
        'vaulter.security.accepted_risks' => $s['risks'] + ['drive.permission-driver' => 'control: isolates the collaboration scenario'],
    ];
}

/** @param array{env?: string, enabled?: bool, ttl?: int, jwt?: ?string, webhook?: ?string, risks?: array<string, string>} $settings */
function wholeAppCommand(array $settings): int
{
    applyWholeAppSettings($settings);
    CollaborationFakeHandler::$handled = 0;
    test()->refreshApplication();
    Artisan::registerCommand(new class extends Command
    {
        protected $signature = 'octane:start';

        public function handle(): int
        {
            CollaborationFakeHandler::$handled++;

            return 0;
        }
    });

    return Artisan::call('octane:start');
}

afterEach(function (): void {
    TestCase::$configOverrides = [];
    TestCase::$environmentOverride = null;
});

it('refuses a guarded production command for missing collaboration secrets before handle() unless a reasoned risk is accepted', function (): void {
    expect(fn (): int => wholeAppCommand([]))->toThrow(InsecureProductionConfiguration::class, 'collaboration.secrets')
        ->and(CollaborationFakeHandler::$handled)->toBe(0)
        ->and(fn (): int => wholeAppCommand(['risks' => ['collaboration.secrets' => ' ']]))->toThrow(InsecureProductionConfiguration::class, 'collaboration.secrets')
        ->and(CollaborationFakeHandler::$handled)->toBe(0)
        ->and(wholeAppCommand(['risks' => ['collaboration.secrets' => 'managed by the platform']]))->toBe(0)
        ->and(CollaborationFakeHandler::$handled)->toBe(1);
});

it('runs a guarded production command with distinct secrets at ttl 1 and 300, and without secrets outside production', function (int $ttl): void {
    expect(wholeAppCommand(['ttl' => $ttl, 'jwt' => bootJwt(), 'webhook' => 'webhook-secret']))->toBe(0)
        ->and(CollaborationFakeHandler::$handled)->toBe(1)
        ->and(wholeAppCommand(['env' => 'testing']))->toBe(0)
        ->and(CollaborationFakeHandler::$handled)->toBe(1);
})->with([1, 300]);

it('requires no collaboration secret when the module is disabled', function (): void {
    expect(wholeAppCommand(['enabled' => false]))->toBe(0)
        ->and(CollaborationFakeHandler::$handled)->toBe(1);
});

it('fails the whole application build on a structural ttl before any guard or risk exemption, even for an accepted risk', function (int $ttl, array $risks): void {
    expect(fn (): int => wholeAppCommand(['ttl' => $ttl, 'jwt' => bootJwt(), 'webhook' => 'webhook-secret', 'risks' => $risks]))->toThrow(InvalidConfiguration::class, 'token_ttl')
        ->and(CollaborationFakeHandler::$handled)->toBe(0);
})->with([0, 301])->with([
    'no risk' => [[]],
    'accepted ttl id' => [['collaboration.token-ttl' => 'we know']],
]);

/** Real non-console HTTP bootstrap: the booted guard throws (or not) before any following statement; no server or request is needed. */
function wholeAppHttp(array $settings): bool
{
    applyWholeAppSettings($settings);
    $_ENV['APP_RUNNING_IN_CONSOLE'] = 'false';
    try {
        test()->refreshApplication();

        return !app()->runningInConsole();
    } finally {
        unset($_ENV['APP_RUNNING_IN_CONSOLE']);
    }
}

it('refuses the HTTP production bootstrap for missing collaboration secrets unless a reasoned risk is accepted', function (): void {
    expect(fn (): bool => wholeAppHttp([]))->toThrow(InsecureProductionConfiguration::class, 'collaboration.secrets')
        ->and(fn (): bool => wholeAppHttp(['jwt' => bootJwt()]))->toThrow(InsecureProductionConfiguration::class, 'collaboration.secrets')
        ->and(fn (): bool => wholeAppHttp(['risks' => ['collaboration.secrets' => ' ']]))->toThrow(InsecureProductionConfiguration::class, 'collaboration.secrets')
        ->and(wholeAppHttp(['risks' => ['collaboration.secrets' => 'managed by the platform']]))->toBeTrue();
});

it('boots HTTP with distinct secrets at ttl 1 and 300 in production, and without secrets in testing or with the module disabled', function (int $ttl): void {
    expect(wholeAppHttp(['ttl' => $ttl, 'jwt' => bootJwt(), 'webhook' => 'webhook-secret']))->toBeTrue()
        ->and(wholeAppHttp(['env' => 'testing', 'ttl' => $ttl]))->toBeTrue()
        ->and(wholeAppHttp(['enabled' => false, 'ttl' => $ttl]))->toBeTrue();
})->with([1, 300]);

it('fails the HTTP bootstrap on a structural ttl or equal secrets before the production guard, in production and testing', function (string $environment, int $ttl, array $risks): void {
    expect(fn (): bool => wholeAppHttp(['env' => $environment, 'ttl' => $ttl, 'jwt' => bootJwt(), 'webhook' => 'webhook-secret', 'risks' => $risks]))->toThrow(InvalidConfiguration::class, 'token_ttl')
        ->and(fn (): bool => wholeAppHttp(['env' => $environment, 'jwt' => bootJwt(), 'webhook' => bootJwt(), 'risks' => ['collaboration.secrets' => 'accepted']]))->toThrow(InvalidConfiguration::class, 'unusable');
})->with(['production', 'testing'])->with([0, 301])->with([
    'no risk' => [[]],
    'accepted ttl id' => [['collaboration.token-ttl' => 'we know']],
]);
