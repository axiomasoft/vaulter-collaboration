<?php

declare(strict_types=1);

/**
 * The configuration of the vaulter-collaboration package, published with the vaulter-collaboration-config tag.
 * The module is opt-in: it is active only after `vaulter.modules.collaboration` is set to `true`, and an active
 * module needs the hub URL, the JWT key set and the webhook secret below.
 */
return [
    'hub' => [
        'url' => env('VAULTER_COLLAB_URL', 'ws://localhost:1234'),
        // The room-token keys (Laravel only, never given to the hub): `kid => secret`, HS256, each at least 32 bytes and
        // different from the webhook secret the hub holds. The environment value is "kid:secret" pairs, comma-separated; a PHP array is accepted too.
        // Tokens are signed with jwt_active_kid and verified with any key of the set: add the new key, switch the active
        // kid, remove the old key once its tokens have expired (docs/key-rotation.md).
        'jwt_keys' => env('VAULTER_COLLAB_JWT_KEYS'),
        'jwt_active_kid' => env('VAULTER_COLLAB_JWT_ACTIVE_KID'),
        // The `iss` of a room token, compared as an exact string with the server configuration (null: app.url).
        'issuer' => env('VAULTER_COLLAB_ISSUER'),
        'webhook_secret' => env('VAULTER_COLLAB_WEBHOOK_SECRET'),
        // The lifetime of a room token (seconds, at most 300): the longest a revoked writer keeps a session when no
        // control message reaches the hub, because a renewal checks the rights again.
        'token_ttl' => 300,
        // The clock difference tolerated on a room token's exp, by the hub and the backend alike (seconds, 0..30);
        // part of the exposure bound token_ttl + clock_skew. Not the tolerance of a request signature (timestamp_tolerance).
        'clock_skew' => 30,
        'timestamp_tolerance' => 300,
    ],
    // How a change of effective permissions (drive.access.effective_permissions_changed) reaches the hubs at once:
    // `redis` publishes on the channel vaulter:collab:control of the connection below, `http` POSTs to the management
    // /control endpoint of every hub listed (signed with hub.webhook_secret), `none` sends nothing — the hubs then learn
    // of it on the next append or renewal. A lost message is never replayed: the token lifetime bounds the exposure.
    'control' => [
        'transport' => env('VAULTER_COLLAB_CONTROL_TRANSPORT', 'none'),
        'redis' => [
            'connection' => env('VAULTER_COLLAB_CONTROL_REDIS', 'default'),
        ],
        'http' => [
            // The management base URLs of the hubs (comma-separated in the environment), e.g. http://hub-1:1235.
            'urls' => env('VAULTER_COLLAB_CONTROL_URLS', ''),
            'timeout' => 2,
        ],
    ],
    // The largest binary Yjs state one hub store may write (413 above it).
    'max_state_bytes' => 16777216,
    // When an edit counts as saved (protocol 2): `buffered` — the hub may sync it before the backend committed it;
    // `durable` — the hub acknowledges an edit only with the backend receipt.
    'mode' => env('VAULTER_COLLAB_MODE', 'buffered'),
    'limits' => [
        // The largest decoded Yjs update one append carries, and the largest append request body (413 above either,
        // checked before the body is decoded).
        'update_bytes' => 1048576,
        'request_bytes' => 2097152,
    ],
    // The hub's compaction worker leases a document with uncheckpointed edits once its log holds this many updates,
    // this many bytes of them, or its oldest one is this many seconds old; a drain request always qualifies. A lease
    // lasts lease_ttl seconds.
    'compaction' => [
        'trigger_updates' => 500,
        'trigger_bytes' => 1048576,
        'trigger_age' => 600,
        'lease_ttl' => 60,
    ],
    'drain' => [
        // How long a restore, REST replace, content read or export of a document with uncheckpointed edits waits for
        // the hub to compact them (seconds); after it the request answers 409 document_state_pending.
        'restore_deadline' => 10,
        // The cache store of the draining flag vaulter:collaboration:drain sets (null: the default store). Every PHP
        // process must see it, so not an `array` or `null` store (the doctor reports one as an error).
        'cache_store' => null,
        // The longest an append transaction lasts, lock waits included (seconds): a drain reports its outcome no earlier
        // than this after it set the flag, so an append that read the flag before it was set has committed by then.
        'max_append_tx' => 5,
    ],
    'retention' => [
        // Days the log and receipts of a closed generation stay after its last token and retry could still arrive.
        'retired_generation_days' => 7,
    ],
    // Same value grammar and vaulter.schedule.enabled switch as the core schedule keys.
    'schedule' => [
        'collaboration_prune' => 'dailyAt:03:40',
    ],
];
