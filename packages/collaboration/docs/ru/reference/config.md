# Частное дополнение: справочник

## Совместное редактирование — `vaulter-collaboration.*`

У пакета `axioma-studio/vaulter-collaboration` собственный файл конфигурации (тег публикации
`vaulter-collaboration-config`), и это opt-in модуль: он активен, только когда `vaulter.modules.collaboration` равен
`true`, и тогда ему нужны URL хаба и оба секрета. Источник истины — Yjs-обновления; JSON TipTap — проекция чекпоинта.

| Ключ | Env | По умолчанию | Управляет |
|---|---|---|---|
| `vaulter-collaboration.driver` | `VAULTER_COLLAB_DRIVER` | `hocuspocus` | Транспорт (только `hocuspocus`) |
| `vaulter-collaboration.hub.url` | `VAULTER_COLLAB_URL` | `ws://localhost:1234` | WebSocket-URL хаба |
| `vaulter-collaboration.hub.jwt_keys` | `VAULTER_COLLAB_JWT_KEYS` | *(не задан)* | Ключи room-токена, пары `kid:secret` (через запятую в окружении): HS256, каждый не короче 32 байт и отличается от webhook-секрета. Токен проверяется любым ключом набора, подписывается ключом `jwt_active_kid`. Только на стороне Laravel, у хаба его нет. |
| `vaulter-collaboration.hub.jwt_active_kid` | `VAULTER_COLLAB_JWT_ACTIVE_KID` | *(не задан)* | Kid ключа, которым подписываются новые и обновлённые токены; он обязан входить в `jwt_keys`. |
| `vaulter-collaboration.hub.issuer` | `VAULTER_COLLAB_ISSUER` | `app.url` | Точный `iss` room-токена из конфигурации сервера (не из Host запроса). |
| `vaulter-collaboration.hub.webhook_secret` | `VAULTER_COLLAB_WEBHOOK_SECRET` | `null` | Общий секрет HMAC-подписи тела каждого вызова хаба; каждый ключ JWT должен отличаться |
| `vaulter-collaboration.hub.token_ttl` | — | `300` | TTL room-токена (секунды, не больше 300): граница экспозиции при потере control-сообщения |
| `vaulter-collaboration.hub.clock_skew` | — | `30` | Допустимый сдвиг часов для `exp` токена (секунды, 0–60) |
| `vaulter-collaboration.mode` | `VAULTER_COLLAB_MODE` | `buffered` | `buffered` или `durable` |
| `vaulter-collaboration.control.transport` | `VAULTER_COLLAB_CONTROL_TRANSPORT` | `none` | `redis`, `http` или `none` |
| `vaulter-collaboration.drain.restore_deadline` | — | `10` | Секунд, которые restore ждёт компактации pending-документа хабом |

Каждый ключ с умолчанием и назначением описан в [Совместном редактировании → Конфигурация](../guides/collaboration.md#конфигурация)
и в сгенерированном списке ниже. Пространство имён комнат — `vaulter-documents.broadcast.channel_prefix`.



## Дополнительные строки справочника

| `vaulter-collaboration.hub.timestamp_tolerance` | `300` секунд |
| `vaulter-collaboration.driver` | `VAULTER_COLLAB_DRIVER` | `'hocuspocus'` | — |
| `vaulter-collaboration.hub.url` | `VAULTER_COLLAB_URL` | `'ws://localhost:1234'` | — |
| `vaulter-collaboration.hub.jwt_keys` / `jwt_active_kid` | `VAULTER_COLLAB_JWT_KEYS` / `VAULTER_COLLAB_JWT_ACTIVE_KID` | `[]` / `null` | Sign and verify the room tokens (Laravel only); every key differs from the webhook secret the hub holds. |
| `vaulter-collaboration.hub.webhook_secret` | `VAULTER_COLLAB_WEBHOOK_SECRET` | `null` | — |
| `vaulter-collaboration.hub.token_ttl` | — | `300` | The lifetime of a room token (seconds, at most 300): the longest a revoked writer keeps a session when no control message reaches the hub, because a renewal checks the rights again (D26). |
| `vaulter-collaboration.hub.clock_skew` | — | `30` | The clock difference tolerated on a room token's exp, by the hub and the backend alike (seconds); part of the exposure bound token_ttl + clock_skew. Not the tolerance of a request signature (timestamp_tolerance). |
| `vaulter-collaboration.hub.timestamp_tolerance` | — | `300` | — |
| `vaulter-collaboration.control` | — | — | How a change of effective permissions (drive.access.effective_permissions_changed) reaches the hubs at once: `redis` publishes on the channel vaulter:collab:control of the connection below, `http` POSTs to the management control endpoint of every hub listed (signed with hub.webhook_secret), `none` sends nothing — the hubs then learn of it on the next append or renewal. A lost message is never replayed: the token lifetime bounds the exposure. |
| `vaulter-collaboration.control.transport` | `VAULTER_COLLAB_CONTROL_TRANSPORT` | `'none'` | — |
| `vaulter-collaboration.control.redis.connection` | `VAULTER_COLLAB_CONTROL_REDIS` | `'default'` | — |
| `vaulter-collaboration.control.http.urls` | `VAULTER_COLLAB_CONTROL_URLS` | `''` | The management base URLs of the hubs (comma-separated in the environment), e.g. http://hub-1:1235. |
| `vaulter-collaboration.control.http.timeout` | — | `2` | — |
| `vaulter-collaboration.max_state_bytes` | — | `16777216` | The largest binary Yjs state one hub store may write (413 above it). |
| `vaulter-collaboration.mode` | `VAULTER_COLLAB_MODE` | `'buffered'` | When an edit counts as saved (protocol 2): `buffered` — the hub may sync it before the backend committed it; `durable` — the hub acknowledges an edit only with the backend receipt. |
| `vaulter-collaboration.limits.update_bytes` | — | `1048576` | The largest decoded Yjs update one append carries, and the largest append request body (413 above either, checked before the body is decoded). |
| `vaulter-collaboration.limits.request_bytes` | — | `2097152` | — |
| `vaulter-collaboration.compaction` | — | — | The hub's compaction worker leases a document with uncheckpointed edits once its log holds this many updates, this many bytes of them, or its oldest one is this many seconds old; a drain request always qualifies. A lease lasts lease_ttl seconds. |
| `vaulter-collaboration.compaction.trigger_updates` | — | `500` | — |
| `vaulter-collaboration.compaction.trigger_bytes` | — | `1048576` | — |
| `vaulter-collaboration.compaction.trigger_age` | — | `600` | — |
| `vaulter-collaboration.compaction.lease_ttl` | — | `60` | — |
| `vaulter-collaboration.drain.restore_deadline` | — | `10` | How long a restore, REST replace, content read or export of a document with uncheckpointed edits waits for the hub to compact them (seconds); after it the request answers 409 document_state_pending. |
| `vaulter-collaboration.drain.cache_store` | — | `null` | The cache store of the draining flag vaulter:collaboration:drain sets (null: the default store). Every PHP process must see it, so not an `array` or `null` store (the doctor reports one as an error). |
| `vaulter-collaboration.drain.max_append_tx` | — | `5` | The longest an append transaction lasts, lock waits included (seconds): a drain reports its outcome no earlier than this after it set the flag, so an append that read the flag before it was set has committed by then. |
| `vaulter-collaboration.retention.retired_generation_days` | — | `7` | Days the log and receipts of a closed generation stay after its last token and retry could still arrive. |
| `vaulter-collaboration.schedule` | — | — | Same value grammar and vaulter.schedule.enabled switch as the core schedule keys. |
| `vaulter-collaboration.schedule.collaboration_prune` | — | `'dailyAt:03:40'` | — |
