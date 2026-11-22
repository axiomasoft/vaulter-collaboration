<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Drain;

use Packman\Attributes\Internal;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\PendingMarker;
use Vaulter\Support\Identity;

/**
 * Every document that carries a pending marker, read through the documents state contract
 * (CollaborativeState::pendingDocuments()) page by page, each page in a short transaction of its own; no lock is held
 * between the pages. What a managed drain and the removal guard decide on.
 */
#[Internal]
final readonly class PendingDocuments
{
    private const int PAGE = 100;

    public function __construct(private VaulterDatabase $database, private CollaborativeState $state) {}

    /** @return list<PendingMarker> in document id order */
    public function all(): array
    {
        $markers = [];
        $after = null;
        do {
            $page = $this->database->transaction(fn (): array => $this->state->pendingDocuments(self::PAGE, $after, protocol: 'yjs'));
            foreach ($page as $marker) {
                $markers[] = $marker;
                $after = Identity::key($marker->documentId);
            }
        } while (count($page) === self::PAGE);

        return $markers;
    }
}
