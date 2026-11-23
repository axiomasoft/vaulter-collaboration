<?php

declare(strict_types=1);

namespace Vaulter\Collaboration\Persistence;

use Packman\Attributes\Internal;
use Vaulter\Attributes\EventSpec;
use Vaulter\Events\Concerns\DescribesEvent;
use Vaulter\Events\EventTypeContract;

#[Internal]
enum CommandEventType: string implements EventTypeContract
{
    use DescribesEvent;

    #[EventSpec(
        subject: 'node',
        data: ['document_id' => 'string', 'receipt_id' => 'string', 'generation' => 'int', 'position' => 'int'],
        activity: false,
        external: false,
        journal: null,
        description: 'A live collaboration command committed.',
    )]
    case Committed = 'collaboration.command_committed';
}
