<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use Vaulter\Collaboration\Http\Support\CollaborationRouteLabels;
use Vaulter\Http\Middleware\VaulterHttpOperationMap;
use Vaulter\Http\Middleware\VaulterThrottledRouteMap;

it('labels only routes the collaboration module mounts, so a renamed route cannot leave a stale label', function (): void {
    $labels = new CollaborationRouteLabels;
    expect($labels->operations())->not->toHaveKey('vaulter.v1.documents.collaboration.session');

    foreach ([...array_keys($labels->operations()), ...array_keys($labels->throttled())] as $name) {
        expect(Route::has($name))->toBeTrue($name);
    }
});

it('adds the session and hub labels to the ones the drive and the documents contribute', function (): void {
    $operations = app(VaulterHttpOperationMap::class);

    expect($operations->operationFor('vaulter.v1.documents.collaboration.session'))->toBe('collab_issue')
        ->and($operations->operationFor('vaulter.v1.collaboration.hub.append'))->toBe('collab_append')
        ->and($operations->operationFor('vaulter.v1.documents.export'))->toBe('doc_export')
        ->and($operations->resolve('POST', 'v1/documents/9/collaboration/session'))->toBe('collab_issue')
        ->and($operations->resolve('POST', 'v1/collaboration/hub/append'))->toBe('collab_append')
        ->and(app(VaulterThrottledRouteMap::class)->routeFor('vaulter.v1.collaboration.hub.append'))->toBe('collab.append')
        ->and(app(VaulterThrottledRouteMap::class)->routeFor('vaulter.v1.collaboration.hub.authenticate'))->toBe('collab.authenticate');
});
