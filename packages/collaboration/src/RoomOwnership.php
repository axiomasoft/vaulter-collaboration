<?php

declare(strict_types=1);

namespace Vaulter\Collaboration;

use Packman\Attributes\Internal;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\Contracts\SupportsCollaboration;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Exceptions\CollaborationUnavailableException;
use Vaulter\Documents\State\LockedDocumentState;
use Vaulter\Documents\Types\DocumentTypeRegistry;
use Vaulter\Kernel;

/** Checks generation ownership and resolves the journal protocol from the locked document's registered driver. */
#[Spi(SpiKind::Call)]
final readonly class RoomOwnership
{
    #[Internal]
    public function __construct(private DocumentTypeRegistry $types, private Kernel $kernel) {}

    public function assertGeneration(LockedDocumentState $document, int $generation): void
    {
        if ($generation !== $document->generation) {
            throw new CollaborationEpochMismatchException(expected: $generation, actual: $document->generation);
        }
    }

    public function protocol(LockedDocumentState $document): string
    {
        $binding = $document->binding;
        $type = $this->types->find($document->type);
        $extensions = $this->kernel->extensions();
        if (!$type instanceof SupportsCollaboration || $binding === null
            || $type->collaborationProtocol() !== $binding->protocol
            || $type->collaborationStateFormat() !== $binding->stateFormat
            || !in_array($binding->protocol, $extensions->handlerKeys(CollaborationProtocolDriver::class), true)) {
            throw new CollaborationUnavailableException('unsupported_binding', $document->type);
        }
        $driver = $extensions->handler(CollaborationProtocolDriver::class, $binding->protocol);
        if ($driver->protocol() !== $binding->protocol
            || !$driver->supportsState($document->type, $binding->stateFormat, $binding->schemaVersion, $document->collabState !== null, CollaborationMode::Read)) {
            throw new CollaborationUnavailableException('unsupported_binding', $document->type);
        }
        $protocol = $driver->version();
        if (!str_starts_with($protocol, $binding->protocol.'/') || !self::isProtocolVersion($protocol)) {
            throw new CollaborationUnavailableException('unsupported_binding', $document->type);
        }

        return $protocol;
    }

    #[Internal]
    public static function isProtocolVersion(string $protocol): bool
    {
        return strlen($protocol) <= 64 && preg_match('/\A[a-z][a-z0-9-]*\/[1-9][0-9]*\z/', $protocol) === 1;
    }
}
