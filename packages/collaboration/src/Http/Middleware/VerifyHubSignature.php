<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Middleware;

use Closure;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Http\Request;
use Packman\Attributes\Internal;
use Symfony\Component\HttpFoundation\Response;
use Vaulter\Collaboration\CollaborationCallResolver;

/**
 * Guards the endpoints the hub calls for itself, not for a room connection: the compaction lease and the checkpoint
 * publication. They carry no room JWT (no user acts), so the HMAC signature of the raw body keyed by the hub webhook
 * secret is the barrier ({@see CollaborationCallResolver::verifyHub()}); anything else is a 401. Without the secret
 * every call is refused.
 */
#[Internal]
final readonly class VerifyHubSignature
{
    public function __construct(private CollaborationCallResolver $resolver) {}

    /** @param Closure(Request): Response $next */
    public function handle(Request $request, Closure $next): Response
    {
        $verified = $this->resolver->verifyHub(
            presentedTimestamp: $request->header(CollaborationCallResolver::TIMESTAMP_HEADER),
            presentedSignature: $request->header(CollaborationCallResolver::SIGNATURE_HEADER),
            rawBody: $request->getContent(),
        );
        // Answered by the problem renderer as 401 actor_required.
        if (!$verified) {
            throw new AuthenticationException('Unauthenticated collaboration hub call.');
        }

        /** @var Response $response */
        $response = $next($request);

        return $response;
    }
}
