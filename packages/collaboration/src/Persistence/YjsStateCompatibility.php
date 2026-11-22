<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Internal;
use Vaulter\Collaboration\HocuspocusCollaborationDriver;
use Vaulter\Documents\Contracts\SupportsCollaboration;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Exceptions\CollaborationUnavailableException;
use Vaulter\Documents\State\CollaborationStateBinding;
use Vaulter\Documents\Types\DocumentTypeRegistry;

/** Compatibility of this concrete Yjs adapter; keyed routing belongs to the driver router. */
#[Internal]
final readonly class YjsStateCompatibility
{
    public function __construct(private DocumentTypeRegistry $types, private HocuspocusCollaborationDriver $driver) {}

    public function assert(string $documentType, ?CollaborationStateBinding $binding, bool $hasCheckpoint): void
    {
        $type = $this->types->find($documentType);
        if (!$type instanceof SupportsCollaboration || $binding === null || $binding->protocol !== 'yjs'
            || !$this->driver->supportsState($documentType, $binding->stateFormat, $binding->schemaVersion, $hasCheckpoint, CollaborationMode::Read) || $type->collaborationProtocol() !== $binding->protocol
            || $type->collaborationStateFormat() !== $binding->stateFormat) {
            throw new CollaborationUnavailableException('unsupported_binding', $documentType);
        }
    }
}
