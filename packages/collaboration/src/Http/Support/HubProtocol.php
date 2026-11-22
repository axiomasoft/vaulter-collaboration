<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Http\Support;

use Illuminate\Http\Request;
use Packman\Attributes\Internal;
use Symfony\Component\HttpFoundation\Response;
use Vaulter\Collaboration\Exceptions\CollaborationProtocolMismatchException;

/**
 * The version of the hub ↔ backend protocol a hub call speaks (header `X-Vaulter-Collab-Protocol`). Every hub route
 * requires protocol 2 — a call without the header or with another version is refused before anything is read — and
 * every answer repeats the header.
 */
#[Internal]
final class HubProtocol
{
    public const string HEADER = 'X-Vaulter-Collab-Protocol';

    public const int VERSION = 2;

    /** @throws CollaborationProtocolMismatchException when the call does not speak protocol 2 */
    public static function require(Request $request): void
    {
        if (self::presented($request) !== (string) self::VERSION) {
            throw new CollaborationProtocolMismatchException(self::presented($request), self::VERSION);
        }
    }

    /**
     * @template T of Response
     *
     * @param  T $response
     * @return T
     */
    public static function mark(Response $response): Response
    {
        $response->headers->set(self::HEADER, (string) self::VERSION);

        return $response;
    }

    private static function presented(Request $request): ?string
    {
        $value = $request->headers->get(self::HEADER);

        return is_string($value) && trim($value) !== '' ? trim($value) : null;
    }
}
