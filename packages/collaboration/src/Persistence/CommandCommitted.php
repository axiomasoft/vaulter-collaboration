<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Internal;
use Vaulter\Events\DomainEvent;
use Vaulter\ValueObjects\Events\EventScope;
use Vaulter\ValueObjects\Events\EventSubject;

#[Internal]
final readonly class CommandCommitted extends DomainEvent
{
    public function __construct(
        private CommandActor $scope,
        private string $documentId,
        private string $receipt,
        private int $generation,
        private int $position,
    ) {
        parent::__construct($scope->principal, $receipt);
    }

    public function type(): CommandEventType
    {
        return CommandEventType::Committed;
    }

    public function scope(): EventScope
    {
        return new EventScope($this->scope->tenant, $this->scope->driveId, 'collaboration');
    }

    public function subject(): EventSubject
    {
        return new EventSubject('node', $this->scope->resourceId);
    }

    public function sequence(): int
    {
        return $this->position;
    }

    /** @return array{document_id: string, receipt_id: string, generation: int, position: int} */
    public function data(): array
    {
        return ['document_id' => $this->documentId, 'receipt_id' => $this->receipt, 'generation' => $this->generation, 'position' => $this->position];
    }
}
