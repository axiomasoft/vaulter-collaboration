<?php

declare(strict_types=1);

return [
    'collaboration_checkpoint_conflict' => [
        'title' => 'Collaboration checkpoint conflict',
        'detail' => 'The document log changed since the compaction lease was granted.',
    ],
    'collaboration_draining' => [
        'title' => 'Collaboration draining',
        'detail' => 'Collaboration is being drained before it is switched off; the update was not saved, retry later.',
    ],
    'collaboration_epoch_mismatch' => [
        'title' => 'Collaboration epoch mismatch',
        'detail' => 'The collaboration session is out of date.',
    ],
    'collaboration_protocol_mismatch' => [
        'title' => 'Collaboration protocol mismatch',
        'detail' => 'The collaboration hub and the server speak different protocol versions.',
    ],
    'collaboration_seed_conflict' => [
        'title' => 'Collaboration seed conflict',
        'detail' => 'The document was seeded differently by another session.',
    ],
    'collaboration_update_mismatch' => [
        'title' => 'Collaboration update mismatch',
        'detail' => 'The update does not match its hash or an update already saved under its id.',
    ],
    'collaboration_update_too_large' => [
        'title' => 'Collaboration update too large',
        'detail' => 'The collaboration update exceeds the allowed size.',
    ],
];
