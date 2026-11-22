<?php

declare(strict_types=1);

use Illuminate\Routing\Route;
use Symfony\Component\Finder\Finder;
use Vaulter\Documents\Http\Controllers\Documents\CreateCollaborationSessionController;
use Vaulter\Drive\Access\AccessResolver;

/**
 * The private collaboration HTTP layer owns only hub controllers. The public session belongs to documents.
 */
const COLLABORATION_V1_CONTROLLER_NAMESPACES = ['Vaulter\Collaboration\Http\Controllers\Collaboration'];

arch('collaboration v1 controllers are final single-action classes')
    ->expect(COLLABORATION_V1_CONTROLLER_NAMESPACES)
    ->toBeFinal()
    ->toHaveMethod('__invoke')
    ->toHaveSuffix('Controller');

it('gives collaboration v1 controllers no public method besides the constructor and __invoke', function (): void {
    $root = dirname(__DIR__, 2).'/src/Http/Controllers';
    $offenders = [];
    foreach ((new Finder)->files()->in($root)->name('*.php') as $file) {
        $class = 'Vaulter\\Collaboration\\Http\\Controllers\\'.str_replace(['/', '.php'], ['\\', ''], substr($file->getPathname(), strlen($root) + 1));
        foreach (new ReflectionClass($class)->getMethods(ReflectionMethod::IS_PUBLIC) as $method) {
            if (!in_array($method->getName(), ['__construct', '__invoke'], true)) {
                $offenders[] = $class.'::'.$method->getName();
            }
        }
    }

    expect($offenders)->toBe([]);
});

arch('collaboration controllers never reach for Repositories or the AccessResolver themselves')
    ->expect(COLLABORATION_V1_CONTROLLER_NAMESPACES)
    ->not->toUse(['Vaulter\Repositories', 'Vaulter\Documents\Repositories', AccessResolver::class]);

it('names every collaboration route vaulter.v1.* under the versioned prefix', function (): void {
    $routes = array_filter(
        iterator_to_array(app('router')->getRoutes()),
        static fn (Route $route): bool => str_starts_with((string) $route->getActionName(), 'Vaulter\Collaboration\\'),
    );

    expect($routes)->not->toBeEmpty();
    $names = array_map(static fn (Route $route): string => (string) $route->getName(), $routes);
    expect(array_values($names))->toHaveCount(7)
        ->toContain('vaulter.v1.collaboration.hub.authenticate', 'vaulter.v1.collaboration.hub.load', 'vaulter.v1.collaboration.hub.renew', 'vaulter.v1.collaboration.hub.append', 'vaulter.v1.collaboration.hub.compaction.lease', 'vaulter.v1.collaboration.hub.checkpoint', 'vaulter.v1.collaboration.hub.recheck');
    foreach ($routes as $route) {
        expect($route->getName())->toStartWith('vaulter.v1.collaboration.hub.')
            ->and($route->uri())->toStartWith('api/vaulter/v1/collaboration/hub/');
    }
    $session = app('router')->getRoutes()->getByName('vaulter.v1.documents.collaboration.session');
    expect($session)->toBeInstanceOf(Route::class)
        ->and($session->getActionName())->toBe(CreateCollaborationSessionController::class)
        ->and($session->uri())->toBe('api/vaulter/v1/documents/{node}/collaboration/session');
});
