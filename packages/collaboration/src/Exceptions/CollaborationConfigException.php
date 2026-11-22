<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Exceptions;

use Override;
use Packman\Attributes\Api;
use Packman\Errors\Data\ErrorDescriptor;
use Packman\Errors\Enums\ErrorCategory;
use Vaulter\Collaboration\Errors\CollaborationErrorCode;
use Vaulter\Exceptions\VaulterException;

/**
 * A realtime-collaboration operation could not proceed because its configuration is
 * incomplete: no usable signing key set, issuer or webhook secret. These
 * are operator-fixable setup errors, surfaced loud rather than failing open.
 */
#[Api]
final class CollaborationConfigException extends VaulterException
{
    public static function missingSecret(): self
    {
        return new self(
            '[Vaulter] Missing a usable Hocuspocus collaboration signing key set. '
            .'Why: minting/verifying a room JWT needs config(vaulter-collaboration.hub.jwt_keys) with a jwt_active_kid of it, every key at least 32 bytes and different from the webhook secret. '
            .'Fix: set VAULTER_COLLAB_JWT_KEYS and VAULTER_COLLAB_JWT_ACTIVE_KID in your environment. '
            .'Docs: '.self::docs('missing-collab-secret'),
        );
    }

    public static function missingIssuer(): self
    {
        return new self(
            '[Vaulter] Missing the room token issuer. '
            .'Why: a room JWT names its issuer (iss) and is refused without it. '
            .'Fix: set VAULTER_COLLAB_ISSUER or the application URL (app.url). '
            .'Docs: '.self::docs('missing-collab-secret'),
        );
    }

    #[Override]
    public function errorDescriptor(): ErrorDescriptor
    {
        return new ErrorDescriptor(code: CollaborationErrorCode::Config, category: ErrorCategory::Internal);
    }
}
