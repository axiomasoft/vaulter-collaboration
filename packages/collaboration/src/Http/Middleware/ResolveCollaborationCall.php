<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Middleware;

use Closure;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Http\Request;
use Packman\Attributes\Internal;
use Symfony\Component\HttpFoundation\Response;
use Vaulter\Collaboration\CollaborationCall;
use Vaulter\Collaboration\CollaborationCallResolver;

/**
 * Guards the server-to-server endpoints the Node Hocuspocus hub calls
 * (collaboration/hub/authenticate, load and store). The room JWT AND an HMAC signature
 * of the raw body are both required ({@see CollaborationCallResolver}); the resolved
 * {@see CollaborationCall} is stashed on the request, anything else is a 401. The
 * endpoints are never open.
 *
 * The JWT is read from the Authorization: Bearer header only, so it stays out of
 * bodies and logs. The signature is read from X-Vaulter-Collab-Timestamp +
 * X-Vaulter-Collab-Signature; the raw body via getContent() — the EXACT bytes the
 * resolver's HMAC check re-derives, never the parsed/re-encoded `$request->all()`.
 */
#[Internal]
final class ResolveCollaborationCall
{
    /**
     * The request attribute the resolved CollaborationCall is stashed under.
     */
    public const string ATTRIBUTE = 'vaulter_collaboration_call';

    public function __construct(
        private readonly CollaborationCallResolver $resolver,
    ) {}

    /** @param Closure(Request): Response $next */
    public function handle(Request $request, Closure $next): Response
    {
        $call = $this->resolver->resolve(
            bearerToken: $this->bearer($request),
            presentedTimestamp: $request->header(CollaborationCallResolver::TIMESTAMP_HEADER),
            presentedSignature: $request->header(CollaborationCallResolver::SIGNATURE_HEADER),
            rawBody: $request->getContent(),
        );

        // Answered by the problem renderer as 401 actor_required.
        if (!$call instanceof CollaborationCall) {
            throw new AuthenticationException('Unauthenticated collaboration call.');
        }

        $request->attributes->set(self::ATTRIBUTE, $call);

        /** @var Response $response */
        $response = $next($request);

        return $response;
    }

    /**
     * The CollaborationCall this middleware guaranteed onto the request — the
     * controller always finds it once the request reaches it.
     */
    public static function call(Request $request): CollaborationCall
    {
        $call = $request->attributes->get(self::ATTRIBUTE);

        if (!$call instanceof CollaborationCall) {
            abort(500, 'Vaulter collaboration call missing — the route is not behind ResolveCollaborationCall.');
        }

        return $call;
    }

    private function bearer(Request $request): ?string
    {
        $bearer = $request->bearerToken();

        return is_string($bearer) && $bearer !== '' ? $bearer : null;
    }
}
