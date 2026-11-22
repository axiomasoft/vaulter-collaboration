<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Security;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Contracts\Security\ProductionInvariant;

/** A configured client hub URL must use wss://; an empty URL is not a violation (the session issues endpoint=null). */
#[Internal]
final readonly class HubUrlInvariant implements ProductionInvariant
{
    public function __construct(private CollaborationOptions $config) {}

    public function id(): string
    {
        return 'collaboration.hub-url';
    }

    public function violation(): ?string
    {
        $url = $this->config->hubUrl();
        if ($url === null || trim($url) === '') {
            return null;
        }
        if (preg_match('~\Awss://[^/\s?#]+~i', trim($url)) === 1) {
            return null;
        }

        return 'vaulter-collaboration.hub.url must be a wss:// URL.';
    }
}
