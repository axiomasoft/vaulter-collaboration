<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Tests\Support;

use Closure;
use Illuminate\Http\Request;
use LogicException;
use Packman\Attributes\Internal;
use PHPUnit\Framework\AssertionFailedError;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Vaulter\Testing\Support\OpenApi\OpenApiContract;
use Vaulter\Testing\Support\OpenApi\OpenApiResponseValidator;

/**
 * Test-only global middleware: every response of a `vaulter.v1.*` route is checked after the response is built
 * against the spec of its owner, and the test fails with the list of violations. A controller of this package answers
 * by the private hub contract (openapi/hub.yaml of the package), every other one by the public v1 contract. Routes a test registers itself as `vaulter.v1.__probe` or `vaulter.v1.__probe.*` are fixtures of the
 * HTTP kernel, not API surface, and stay outside the contract.
 */
#[Internal]
final class ValidateReleaseOpenApiResponses
{
    public const string PREFIX = 'vaulter.v1.';

    private const string PROBE = 'vaulter.v1.__probe';

    private static ?OpenApiContract $hub = null;

    public static function hubContract(): OpenApiContract
    {
        return self::$hub ??= OpenApiContract::fromFile(dirname(__DIR__, 2).'/openapi/hub.yaml');
    }

    public static function isProbe(string $name): bool
    {
        return $name === self::PROBE || str_starts_with($name, self::PROBE.'.');
    }

    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        return $response instanceof Response ? $response : throw new LogicException('The response contract check wraps a middleware stack that returns a Symfony response.');
    }

    public function terminate(Request $request, Response $response): void
    {
        $name = (string) $request->route()?->getName();
        if (!str_starts_with($name, self::PREFIX) || self::isProbe($name)) {
            return;
        }

        $headers = [];
        foreach ($response->headers->allPreserveCase() as $header => $values) {
            $headers[strtolower((string) $header)] = implode(', ', array_filter((array) $values, is_string(...)));
        }

        $streamed = $response instanceof StreamedResponse || $response instanceof BinaryFileResponse;
        $private = str_starts_with($request->route()?->getActionName() ?? '', 'Vaulter\\Collaboration\\');
        $violations = new OpenApiResponseValidator($private ? self::hubContract() : OpenApiContract::shared())->validate(
            substr($name, strlen(self::PREFIX)),
            $response->getStatusCode(),
            $headers,
            $streamed || $request->isMethod('HEAD') ? '' : (string) $response->getContent(),
            inspectBody: !$streamed && !$request->isMethod('HEAD'),
        );

        if ($streamed && str_contains($headers['content-type'] ?? '', 'json')) {
            $violations[] = "{$name}: a JSON response must not be streamed: its body cannot be validated";
        }

        if ($violations !== []) {
            throw new AssertionFailedError(
                "{$request->method()} {$request->getPathInfo()} breaks the OpenAPI contract:\n - ".implode("\n - ", $violations),
            );
        }
    }
}
