<?php

declare(strict_types=1);

use Vaulter\Collaboration\Schema\CollaborationSchema;
use Vaulter\Schema\VaulterMigration;

return new class extends VaulterMigration
{
    public function up(): void
    {
        app(CollaborationSchema::class)->indexCompactionScans();
    }

    public function down(): void
    {
        app(CollaborationSchema::class)->dropCompactionScanIndexes();
    }
};
