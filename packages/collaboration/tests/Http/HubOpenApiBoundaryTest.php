<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use Symfony\Component\Yaml\Yaml;
use Vaulter\Configuration\RoutesOptions;
use Vaulter\Http\Problems\ProblemCatalog;
use Vaulter\Operations\OperationsReference;
use Vaulter\Repo\Tests\Support\ReleaseOpenApi;
use Vaulter\Testing\Support\OpenApi\OpenApiContract;
use Vaulter\Testing\Support\OpenApi\OpenApiResponseValidator;

// The ownership rules come from the release manifest of the monorepo: those cases run where it exists, the HTTP case
// runs everywhere (a split collaboration package has no manifest and no sibling specs to compare with).
$releaseOpenApi = dirname(__DIR__, 4).'/tests/Repo/Arch/Support/ReleaseOpenApi.php';
if (is_file($releaseOpenApi)) {
    require_once $releaseOpenApi;
}

it('covers every private owned route with closed references and synchronized shared primitives', function (): void {
    $private = ReleaseOpenApi::privateContract();
    ReleaseOpenApi::assertContract($private, ReleaseOpenApi::routes(Route::getRoutes()->getRoutes(), 'private'));
    ReleaseOpenApi::assertSharedPrimitives(OpenApiContract::shared(), $private);
    expect(OpenApiContract::shared()->operation('documents.collaboration.session'))->not->toBeNull()
        ->and($private->operation('documents.collaboration.session'))->toBeNull();
})->skip(!class_exists(ReleaseOpenApi::class), 'needs the release manifest of the monorepo');

it('declares exactly the private owner problem codes and current retry receipt and status policies', function (): void {
    $problem = ReleaseOpenApi::privateContract()->document->components->schemas->Problem;
    $actual = [];
    foreach (get_object_vars($problem->{'x-vaulter-problems'}) as $code => $row) {
        if (ReleaseOpenApi::moduleChannel($row->module) === 'private') {
            $actual[$code] = (array) $row;
        }
    }
    $expected = [];
    foreach (app(ProblemCatalog::class)->all() as $code => $row) {
        if (ReleaseOpenApi::moduleChannel($row['module']) === 'private') {
            $expected[$code] = ['status' => $row['status'], 'retryable' => $row['retryable']->value, 'receipt' => $row['receipt']->value, 'module' => $row['module']];
        }
    }
    expect($actual)->not->toBeEmpty()->toBe($expected)
        ->and($problem->required)->toBe(['type', 'title', 'status', 'code', 'request_id']);
    foreach (get_object_vars(OpenApiContract::shared()->document->components->schemas->Problem->{'x-vaulter-problems'}) as $row) {
        expect(ReleaseOpenApi::moduleChannel($row->module))->toBe('public');
    }
})->skip(!class_exists(ReleaseOpenApi::class), 'needs the release manifest of the monorepo');

it('covers private catalog policies without receipt or If Match bypasses', function (): void {
    $contract = ReleaseOpenApi::privateContract();
    $byRoute = [];
    foreach (app(OperationsReference::class)->rows() as $row) {
        if (ReleaseOpenApi::moduleChannel($row['module']) === 'private') {
            foreach ($row['routes'] as $route) {
                $byRoute[$route] = $row;
            }
        }
    }
    $ids = array_keys($contract->operations());
    sort($ids);
    $routes = array_keys($byRoute);
    sort($routes);
    expect($routes)->toBe($ids);
    foreach ($contract->operations() as $id => $entry) {
        $row = $byRoute[$id];
        expect($row['idempotency'])->toBe('protocol')->and($row['concurrency'])->toBe('generation');
        $parameters = [];
        foreach ($entry['operation']->parameters ?? [] as $parameter) {
            [$parameter] = $contract->resolve($parameter, '');
            $parameters[strtolower($parameter->name)] = $parameter->required ?? false;
        }
        expect($parameters)->not->toHaveKey('idempotency-key')->not->toHaveKey('if-match')
            ->and($parameters['x-vaulter-collab-protocol'] ?? false)->toBeTrue()
            ->and(isset($entry['operation']->responses->{'409'}))->toBeTrue();
        foreach (get_object_vars($entry['operation']->responses) as $response) {
            [$response] = $contract->resolve($response, '');
            expect(isset($response->headers->{'Idempotent-Replayed'}))->toBeFalse();
        }
    }
})->skip(!class_exists(ReleaseOpenApi::class), 'needs the release manifest of the monorepo');

it('rejects a missing endpoint an orphan ref and missing problem metadata in isolated fixtures', function (): void {
    $source = Yaml::parseFile(ReleaseOpenApi::root().'/packages/collaboration/openapi/hub.yaml');
    $routes = ReleaseOpenApi::routes(Route::getRoutes()->getRoutes(), 'private');
    $cases = [];
    $missing = $source;
    unset($missing['paths'][array_key_first($missing['paths'])]);
    $cases[] = $missing;
    $orphan = $source;
    $orphan['paths']['/collaboration/hub/authenticate']['post']['responses']['200']['content']['application/json']['schema']['$ref'] = '#/components/schemas/MissingResponse';
    $cases[] = $orphan;
    $metadata = $source;
    unset($metadata['components']['schemas']['Problem']['x-vaulter-problems']);
    $cases[] = $metadata;
    foreach ($cases as $fixture) {
        expect(fn () => ReleaseOpenApi::assertContract(OpenApiContract::fromYaml(Yaml::dump($fixture, 30)), $routes))->toThrow(LogicException::class);
    }
})->skip(!class_exists(ReleaseOpenApi::class), 'needs the release manifest of the monorepo');

// The public types never read the hub contract: the Vue job's api:check regenerates them from openapi/vaulter-v1.yaml.
it('detects a private response mutation in a temp contract report', function (): void {
    $root = ReleaseOpenApi::root();
    $dir = sys_get_temp_dir().'/vaulter-private-contract-'.bin2hex(random_bytes(8));
    mkdir($dir);
    try {
        $private = ReleaseOpenApi::privateContract();
        $fixture = Yaml::parseFile($root.'/packages/collaboration/openapi/hub.yaml');
        $change = json_decode(file_get_contents(__DIR__.'/../Fixtures/OpenApi/private-response-change.json'), true, flags: JSON_THROW_ON_ERROR);
        $fixture['components']['schemas'][$change['schema']]['properties'][$change['property']]['type'] = $change['type'];
        file_put_contents($dir.'/hub.yaml', Yaml::dump($fixture, 30));
        $mutated = OpenApiContract::fromFile($dir.'/hub.yaml');
        $headers = ['content-type' => 'application/json', 'x-vaulter-api-version' => '1', 'x-request-id' => 'fixture', 'cache-control' => 'no-store, private', 'x-vaulter-collab-protocol' => '2'];
        $body = json_encode(['allowed' => true, 'mode' => 'rw', 'userId' => '42', 'epoch' => 1], JSON_THROW_ON_ERROR);
        expect(new OpenApiResponseValidator($private)->validate('collaboration.hub.authenticate', 200, $headers, $body))->toBe([])
            ->and(new OpenApiResponseValidator($mutated)->validate('collaboration.hub.authenticate', 200, $headers, $body))->not->toBe([])
            ->and(ReleaseOpenApi::report($mutated))->not->toBe(ReleaseOpenApi::report($private));
    } finally {
        foreach (glob($dir.'/*') as $path) {
            unlink($path);
        }
        rmdir($dir);
    }
})->skip(!class_exists(ReleaseOpenApi::class), 'needs the release manifest of the monorepo');

it('validates an actual unsigned hub refusal against its private owner contract', function (): void {
    $this->postJson('/'.app(RoutesOptions::class)->versionedPrefix().'/collaboration/hub/authenticate', [], ['X-Vaulter-Collab-Protocol' => '2'])
        ->assertStatus(401)
        ->assertJsonPath('code', 'actor_required');
});
