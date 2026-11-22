<?php

declare(strict_types=1);

use Illuminate\Config\Repository;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Container\Container;
use Illuminate\Foundation\Application;
use Illuminate\Support\Facades\Context;
use Packman\Config\Exceptions\InvalidConfiguration;
use Vaulter\Collaboration\CollaborationSchedule;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Http\Controllers\Collaboration\HubCompactionLeaseController;
use Vaulter\Collaboration\Providers\CollaborationRegistrar;
use Vaulter\Support\LoadTier;

// The wiring the addon owns after the boundary: the validator tag identity, the ScheduleConfig resolved from the
// container, the lease expiry bytes formatted locally and the tier label read through the stable seam.

it('tags the config validator under the documented stable service tag', function (): void {
    $app = new Application;
    Container::setInstance($this->app);

    (new CollaborationRegistrar)->register($app);

    $validators = iterator_to_array($app->tagged('vaulter.config_validators'));

    expect($validators)->toHaveCount(1)->and($validators[0])->toBeInstanceOf(Closure::class);
});

it('defines the prune task from validated schedule values, with overlap and single-server guards', function (): void {
    $config = new Repository(['vaulter-collaboration' => ['schedule' => ['collaboration_prune' => 'dailyAt:03:40']]]);

    $schedule = new Schedule;
    $this->app->make(CollaborationSchedule::class)->define($schedule, $config);

    $events = $schedule->events();

    expect($events)->toHaveCount(1)
        ->and($events[0]->command)->toContain('vaulter:collaboration:prune')
        ->and($events[0]->expression)->toBe('40 3 * * *')
        ->and($events[0]->withoutOverlapping)->toBeTrue()
        ->and($events[0]->onOneServer)->toBeTrue();
});

it('formats the lease expiry as UTC with microseconds and a trailing Z whatever the zone of the instant', function (): void {
    $wire = new ReflectionMethod(HubCompactionLeaseController::class, 'wire');

    $zoned = new DateTimeImmutable('2026-10-27 12:34:56.123456', new DateTimeZone('Europe/Moscow'));

    expect($wire->invoke(null, $zoned))->toBe('2026-10-27T09:34:56.123456Z')
        ->and($wire->invoke(null, new DateTime('2026-01-02 03:04:05', new DateTimeZone('UTC'))))->toBe('2026-01-02T03:04:05.000000Z');
});

it('labels the tier through the stable seam: normalized, request first, default S0', function (): void {
    Context::forget('vaulter_load_tier');
    expect(LoadTier::label())->toBe('S0');

    LoadTier::set('m');
    expect(LoadTier::label())->toBe('M');

    LoadTier::set(null);
});

it('rejects unknown configuration keys before runtime wiring', function (): void {
    expect(fn (): CollaborationOptions => CollaborationOptions::fromArray(['hub' => ['unexpected' => true]]))
        ->toThrow(InvalidConfiguration::class);
});
