<?php

declare(strict_types=1);

use Vaulter\Collaboration\Schema\CollaborationSchema;
use Vaulter\Collaboration\Schema\StrictRoomSchema;
use Vaulter\Schema\VaulterMigration;

return new class extends VaulterMigration
{
    public function up(): void
    {
        app(StrictRoomSchema::class)->addOwnership();
        app(CollaborationSchema::class)->create('collaboration_client_ids');
        app(CollaborationSchema::class)->create('collaboration_commands');
        app(StrictRoomSchema::class)->indexCommands();
    }

    public function down(): void
    {
        app(CollaborationSchema::class)->drop('collaboration_commands');
        app(CollaborationSchema::class)->drop('collaboration_client_ids');
        app(StrictRoomSchema::class)->dropOwnership();
    }
};
