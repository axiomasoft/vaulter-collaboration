<?php

declare(strict_types=1);

use Illuminate\Container\Container;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Contracts\Auth\Factory as AuthFactory;
use Illuminate\Foundation\Application;
use Illuminate\Support\Facades\Broadcast;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\HostUserResolver as DefaultHostUserResolver;
use Vaulter\Collaboration\Providers\CollaborationRegistrar;

it('binds the host user resolver in an isolated container', function (): void {
    $app = new Application;
    Container::setInstance($this->app);
    $app->instance(AuthFactory::class, $this->app->make(AuthFactory::class));

    (new CollaborationRegistrar)->register($app);

    expect($app->make(HostUserResolver::class))->toBeInstanceOf(DefaultHostUserResolver::class);
});

it('registers the room channel under the channel prefix of the documents and rejects a user that cannot be authorized', function (): void {
    config()->set('vaulter-documents.broadcast.channel_prefix', 'host.documents');
    $callback = null;
    Broadcast::shouldReceive('channel')->once()->withArgs(function (string $name, Closure $authorize) use (&$callback): bool {
        $callback = $authorize;

        return $name === 'host.documents.{roomId}';
    });

    (new CollaborationRegistrar)->register($this->app);
    (new CollaborationRegistrar)->boot($this->app);

    expect($callback)->toBeInstanceOf(Closure::class)
        ->and($callback(Mockery::mock(Authenticatable::class), 123))->toBeFalse();
});
