<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\Data\Collaboration\CollaborationGrant;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Data\Collaboration\CollaborationSession;

#[Internal]
final readonly class HocuspocusCollaborationDriver implements CollaborationProtocolDriver
{
    public function __construct(private CollaborationOptions $config, private RoomTokens $tokens) {}

    public function protocol(): string
    {
        return 'yjs';
    }

    public function version(): string
    {
        return 'yjs/2';
    }

    public function supportsState(string $documentType, string $stateFormat, int $schemaVersion, bool $hasCheckpoint, CollaborationMode $mode): bool
    {
        return in_array($documentType, ['vaulter/rich-text', 'vaulter/markdown'], true) && $stateFormat === 'yjs-update-v1' && $schemaVersion === 1;
    }

    public function issueSession(CollaborationGrant $grant): CollaborationSession
    {
        $minted = $this->tokens->mint(principal: $grant->principal, documentId: $grant->nodeId,
            driveId: $grant->driveId, tenant: $grant->tenant, generation: $grant->generation,
            schemaVersion: $grant->schemaVersion, writable: $grant->mode === CollaborationMode::Write, protocol: $grant->protocol, stateFormat: $grant->stateFormat, notAfter: $grant->notAfter);

        return new CollaborationSession(protocol: $this->protocol(), version: $this->version(), endpoint: $this->config->hubUrl(),
            token: $minted['token'], expiresAt: $minted['exp'], mode: $grant->mode, nodeId: $grant->nodeId,
            generation: $grant->generation, schemaVersion: $grant->schemaVersion,
            options: ['room' => $minted['room'], 'drive_id' => $grant->driveId]);
    }
}
