<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Internal;
use Vaulter\Documents\State\CollaborationStateBinding;

/** An opaque 64-hex lease capability also commits to the exact descriptor it leased. */
#[Internal]
final class LeaseBinding
{
    public static function issue(string $documentId, string $type, CollaborationStateBinding $binding, int $version): string
    {
        $nonce = bin2hex(random_bytes(16));

        return $nonce.self::digest($nonce, $documentId, $type, $binding, $version);
    }

    public static function matches(string $token, string $documentId, string $type, CollaborationStateBinding $binding, int $version): bool
    {
        return strlen($token) === 64 && hash_equals(substr($token, 32), self::digest(substr($token, 0, 32), $documentId, $type, $binding, $version));
    }

    private static function digest(string $nonce, string $documentId, string $type, CollaborationStateBinding $binding, int $version): string
    {
        return substr(hash('sha256', json_encode(['vaulter-lease-binding-v1', $nonce, $documentId, $type, $binding->protocol, $binding->stateFormat, $binding->schemaVersion, $binding->generation, $version], JSON_THROW_ON_ERROR)), 0, 32);
    }
}
