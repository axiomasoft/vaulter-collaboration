<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Security;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Contracts\Security\ProductionInvariant;

/** A usable JWT key set (nonempty, active kid, keys of at least 32 bytes) different from the webhook secret; the values are never part of the message. */
#[Internal]
final readonly class SecretsInvariant implements ProductionInvariant
{
    public function __construct(private CollaborationOptions $config) {}

    public function id(): string
    {
        return 'collaboration.secrets';
    }

    public function violation(): ?string
    {
        if ($this->config->hubWebhookSecret() !== null && $this->config->hubJwtKeysViolation() === null) {
            return null;
        }

        return 'Collaboration requires a nonempty webhook secret and a nonempty, different vaulter-collaboration.hub.jwt_keys set (each key at least 32 bytes, an existing jwt_active_kid; VAULTER_COLLAB_JWT_KEYS, VAULTER_COLLAB_JWT_ACTIVE_KID, VAULTER_COLLAB_WEBHOOK_SECRET).';
    }
}
