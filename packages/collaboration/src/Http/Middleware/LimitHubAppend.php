<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Packman\Attributes\Internal;
use Symfony\Component\HttpFoundation\Response;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Collaboration\Exceptions\CollaborationUpdateTooLargeException;

/**
 * The size gate of the hub's protocol 2 write routes, ahead of the signature check: a body above
 * `vaulter-collaboration.limits.request_bytes` (the append, the compaction lease and the recheck) or above the checkpoint
 * limit (a base64 state of `max_state_bytes` plus `request_bytes` for the rest) is refused by its Content-Length (413
 * collaboration_update_too_large) before anything reads it. The route parameter `checkpoint` takes the checkpoint limit;
 * `append` takes it for a request that declares the seed of an empty log (`X-Vaulter-Collab-Seed: 1`), which carries
 * the document's whole initial state — the append holds any other body to `request_bytes` once it read it. The gate
 * never reads the body to measure it: a request without a Content-Length, or with one that is not a plain decimal, is
 * refused the same way (the hub always sends one).
 */
#[Internal]
final readonly class LimitHubAppend
{
    /** The route parameter that sizes the gate for a checkpoint publication. */
    public const string CHECKPOINT = 'checkpoint';

    /** The route parameter that sizes the gate for an append: a seed may carry a whole state. */
    public const string APPEND = 'append';

    /** The header the hub marks the append of a seed with. */
    public const string SEED_HEADER = 'X-Vaulter-Collab-Seed';

    public function __construct(private CollaborationOptions $config) {}

    /** @param Closure(Request): Response $next */
    public function handle(Request $request, Closure $next, ?string $body = null): Response
    {
        $state = $body === self::CHECKPOINT || ($body === self::APPEND && self::declaresSeed($request));
        $max = $state ? $this->config->checkpointRequestBytes() : $this->config->requestBytes();
        $declared = $request->headers->get('Content-Length');
        if (!is_string($declared) || !ctype_digit($declared)) {
            throw CollaborationUpdateTooLargeException::undeclared($max);
        }
        $size = (int) $declared;
        if ($size > $max) {
            throw new CollaborationUpdateTooLargeException($size, $max);
        }

        /** @var Response $response */
        $response = $next($request);

        return $response;
    }

    /** Whether the request declares the append of a seed. */
    private static function declaresSeed(Request $request): bool
    {
        return $request->headers->get(self::SEED_HEADER) === '1';
    }
}
