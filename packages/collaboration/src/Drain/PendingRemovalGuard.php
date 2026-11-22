<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Drain;

use Packman\Attributes\Internal;
use Vaulter\Modules\RemovalGuard;

/**
 * The collaboration module refuses its removal while a document carries a pending marker: those saved edits
 * live only in the log `vaulter:module:uninstall collaboration --purge` would delete. `vaulter:collaboration:drain`
 * checkpoints them first. It reads the documents' markers through their state contract, never a table of its own, so it
 * answers for an inactive module too (the module is switched off before its removal) and between its rollbacks.
 */
#[Internal]
final readonly class PendingRemovalGuard implements RemovalGuard
{
    private const string MODULE = 'collaboration';

    public function __construct(private PendingDocuments $documents) {}

    public function blockers(string $module): array
    {
        if ($module !== self::MODULE) {
            return [];
        }
        $pending = count($this->documents->all());

        return $pending === 0 ? [] : ['document(s) with saved collaboration edits not in a checkpoint yet (vaulter:collaboration:drain checkpoints them)' => $pending];
    }
}
