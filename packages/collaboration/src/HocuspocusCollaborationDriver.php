<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\Configuration\CollaborationOptions;
use Vaulter\Documents\Configuration\DocumentsOptions;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\Data\Collaboration\CollaborationGrant;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Data\Collaboration\CollaborationSession;

#[Internal]
final readonly class HocuspocusCollaborationDriver implements CollaborationProtocolDriver
{
    public function __construct(private CollaborationOptions $config, private RoomTokens $tokens, private DocumentsOptions $documents) {}

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
        return $stateFormat === 'yjs-update-v1' && match ($documentType) {
            'vaulter/rich-text' => $schemaVersion === 1 || ($schemaVersion === 2 && $this->documents->tiptap->blockIds),
            'vaulter/markdown' => $schemaVersion === 1,
            default => false,
        };
    }

    public function issueSession(CollaborationGrant $grant): CollaborationSession
    {
        $minted = $this->tokens->mint(principal: $grant->principal, documentId: $grant->nodeId,
            driveId: $grant->driveId, tenant: $grant->tenant, generation: $grant->generation,
            schemaVersion: $grant->schemaVersion, writable: $grant->mode === CollaborationMode::Write, protocol: $grant->protocol, stateFormat: $grant->stateFormat, notAfter: $grant->notAfter);

        return new CollaborationSession(protocol: $this->protocol(), version: $this->version(), endpoint: $this->config->hubUrl(),
            token: $minted['token'], expiresAt: $minted['exp'], mode: $grant->mode, nodeId: $grant->nodeId,
            generation: $grant->generation, schemaVersion: $grant->schemaVersion,
            options: ['room' => $minted['room'], 'drive_id' => $grant->driveId]
                + ($this->config->strictProfile() ? ['writer_binding' => true] : []));
    }
}
