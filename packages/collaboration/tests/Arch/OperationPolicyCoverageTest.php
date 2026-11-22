<?php

declare(strict_types=1);

use Illuminate\Routing\Route;
use Illuminate\Support\Facades\Route as Router;
use Symfony\Component\Finder\Finder;
use Vaulter\Http\Middleware\ReadIdempotencyKey;
use Vaulter\Operations\ConcurrencyPolicy;
use Vaulter\Operations\IdempotencyPolicy;
use Vaulter\Operations\OperationCatalog;
use Vaulter\Operations\OperationPolicy;

/**
 * Coverage of the collaboration's operation policies, for every route of the
 * package: (a) no operation name in src is missing from the catalog (the package runs none of its own: the session issues
 * a token without a write, the hub is a protocol with its own deduplication), (b) every mutating v1 route of the package
 * is in exactly one policy, (c) no route of the package reads the Idempotency-Key — none of its policies is a receipt —
 * and (d) the policies say what the routes are: the session natural, the hub a protocol fenced by the generation.
 */

/** @return array<string, OperationPolicy> */
function cpcPolicies(): array
{
    $policies = [];
    foreach (app(OperationCatalog::class)->all() as $name => $entry) {
        if ($entry['module'] === 'collaboration') {
            $policies[$name] = $entry['policy'];
        }
    }

    return $policies;
}

/** @return array<string, Route> the mutating v1 routes the collaboration package owns, by name without the prefix */
function cpcRoutes(): array
{
    $routes = [];
    foreach (Router::getRoutes()->getRoutes() as $route) {
        $name = (string) $route->getName();
        if (!str_starts_with($name, 'vaulter.v1.') || !str_starts_with($route->getActionName(), 'Vaulter\\Collaboration\\')) {
            continue;
        }
        if (array_intersect($route->methods(), ['POST', 'PUT', 'PATCH', 'DELETE']) !== []) {
            $routes[substr($name, strlen('vaulter.v1.'))] = $route;
        }
    }

    return $routes;
}

it('(a) runs no operation of its own: every OperationSpec of the sources is in the catalog', function (): void {
    $names = [];
    foreach ((new Finder)->files()->in(dirname(__DIR__, 2).'/src')->name('*.php') as $file) {
        if (preg_match_all("/new OperationSpec\\('([a-z_.]+)'/", $file->getContents(), $literal) > 0) {
            array_push($names, ...$literal[1]);
        }
    }
    $catalog = app(OperationCatalog::class);

    expect(array_values(array_filter($names, static fn (string $name): bool => $catalog->policy($name) === null || $catalog->module($name) !== 'collaboration')))->toBe([])
        // A policy without a run (the session, the hub protocol) names routes instead.
        ->and(array_values(array_filter(cpcPolicies(), static fn (OperationPolicy $policy): bool => $policy->routes === [])))->toBe([]);
});

it('(b) puts every mutating v1 route of the package in exactly one policy, the session and every hub call included', function (): void {
    $owners = [];
    foreach (cpcPolicies() as $name => $policy) {
        foreach ($policy->routes as $route) {
            $owners[$route][] = $name;
        }
    }
    $routes = cpcRoutes();

    expect(array_keys($routes))->toContain('collaboration.hub.authenticate', 'collaboration.hub.load', 'collaboration.hub.renew', 'collaboration.hub.append', 'collaboration.hub.compaction.lease', 'collaboration.hub.checkpoint', 'collaboration.hub.recheck')
        ->and(array_values(array_diff(array_keys($routes), array_keys($owners))))->toBe([])
        ->and(array_values(array_diff(array_keys($owners), array_keys($routes))))->toBe([])
        ->and(array_values(array_filter($owners, static fn (array $names): bool => count($names) !== 1)))->toBe([]);
});

it('(c) reads the Idempotency-Key on no route of the package: none of its policies is a receipt', function (): void {
    $reads = [];
    foreach (cpcRoutes() as $name => $route) {
        if (in_array(ReadIdempotencyKey::ALIAS, $route->gatherMiddleware(), true)) {
            $reads[] = $name;
        }
    }

    expect($reads)->toBe([])
        ->and(array_values(array_filter(cpcPolicies(), static fn (OperationPolicy $policy): bool => $policy->idempotency === IdempotencyPolicy::Receipt)))->toBe([]);
});

it('(d) declares the session natural and the hub a protocol fenced by the generation, on no If-Match route', function (): void {
    $policies = cpcPolicies();

    expect($policies['collaboration.hub.protocol']->idempotency)->toBe(IdempotencyPolicy::Protocol)
        ->and($policies['collaboration.hub.protocol']->concurrency)->toBe(ConcurrencyPolicy::Generation)
        ->and($policies['collaboration.hub.protocol']->aggregate)->toBe('collaboration.document_log')
        ->and(array_values(array_filter($policies, static fn (OperationPolicy $policy): bool => $policy->concurrency === ConcurrencyPolicy::IfMatch)))->toBe([]);
});
