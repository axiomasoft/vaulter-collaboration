<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use OpenTelemetry\API\Globals;
use OpenTelemetry\API\Trace\Propagation\TraceContextPropagator;
use OpenTelemetry\API\Trace\SpanInterface;
use OpenTelemetry\API\Trace\SpanKind;
use OpenTelemetry\API\Trace\StatusCode;
use Packman\Attributes\Internal;
use Symfony\Component\HttpFoundation\Response;
use Throwable;
use Vaulter\Contracts\Observability\TraceRecorder;
use Vaulter\Observability\OtlpOpenTelemetryTraceRecorder;

/**
 * Extracts W3C `traceparent` from authenticated collaboration hub calls and wraps
 * request execution in an OpenTelemetry server span without leaking raw exception messages.
 */
#[Internal]
final readonly class TraceCollaborationCall
{
    public function __construct(
        private ?TraceRecorder $tracer = null,
    ) {}

    /** @param Closure(Request): Response $next */
    public function handle(Request $request, Closure $next): Response
    {
        $inboundTraceparent = self::validTraceparent($request->header('traceparent'));
        $span = $this->startOtelSpan($request, $inboundTraceparent);
        $scope = $span?->activate();
        $effectiveTraceparent = self::spanTraceparent($span) ?? $inboundTraceparent;

        try {
            $route = $request->route()?->getName() ?? $request->path();
            $routeLabel = $route !== '' ? $route : 'hub';
            $run = static fn (): Response => $next($request);

            $tracer = $this->tracer;
            if ($tracer instanceof OtlpOpenTelemetryTraceRecorder) {
                $attributes = [
                    'http.request.method' => $request->method(),
                    'url.path' => '/'.ltrim($request->path(), '/'),
                    'vaulter.collab.route' => $routeLabel,
                ];
                $response = $tracer->withTraceparent(
                    $effectiveTraceparent,
                    static fn (): Response => $tracer->span('vaulter.collaboration.hub', $run, $attributes),
                );
            } else {
                $response = $run();
            }

            $span?->setStatus($response->getStatusCode() >= 500 ? StatusCode::STATUS_ERROR : StatusCode::STATUS_OK);

            return $response;
        } catch (Throwable $exception) {
            // Never export raw exception messages (e.g. QueryException SQL bindings).
            $span?->setAttribute('error.type', $exception::class);
            $code = $exception->getCode();
            if (is_int($code)) {
                $span?->setAttribute('error.code', $code);
            } elseif (preg_match('/\A[A-Za-z0-9_.-]{1,32}\z/', $code) === 1) {
                $span?->setAttribute('error.code', $code);
            }
            $span?->setStatus(StatusCode::STATUS_ERROR, $exception::class);

            throw $exception;
        } finally {
            $scope?->detach();
            $span?->end();
        }
    }

    private function startOtelSpan(Request $request, ?string $traceparent): ?SpanInterface
    {
        if (!class_exists(Globals::class)) {
            return null;
        }

        $parent = $traceparent !== null
            ? TraceContextPropagator::getInstance()->extract(['traceparent' => $traceparent])
            : null;
        $route = $request->route()?->getName() ?? $request->path();
        $builder = Globals::tracerProvider()
            ->getTracer('vaulter.collaboration')
            ->spanBuilder('vaulter.collaboration.hub')
            ->setSpanKind(SpanKind::KIND_SERVER)
            ->setAttribute('http.request.method', $request->method())
            ->setAttribute('url.path', '/'.ltrim($request->path(), '/'))
            ->setAttribute('vaulter.collab.route', $route !== '' ? $route : 'hub');

        if ($parent !== null) {
            $builder->setParent($parent);
        }

        return $builder->startSpan();
    }

    private static function spanTraceparent(?SpanInterface $span): ?string
    {
        if ($span === null || !$span->getContext()->isValid()) {
            return null;
        }

        return OtlpOpenTelemetryTraceRecorder::formatTraceparent(
            $span->getContext()->getTraceId(),
            $span->getContext()->getSpanId(),
            $span->getContext()->isSampled(),
        );
    }

    private static function validTraceparent(mixed $raw): ?string
    {
        return is_string($raw) && OtlpOpenTelemetryTraceRecorder::parseTraceparent($raw) !== null
            ? strtolower(trim($raw))
            : null;
    }
}
