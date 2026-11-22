# Частное дополнение: справочник

## unknown-collaboration-driver

`VaulterException` из `CollaborationDriverManager`: выберите `hocuspocus` в
`vaulter-collaboration.driver`. Удалённый драйвер `reverb` даёт
`InvalidConfigurationException` с явным сообщением.


## missing-collab-secret

Драйверу Hocuspocus нужен рабочий набор ключей room-токена: `VAULTER_COLLAB_JWT_KEYS` (пары `kid:secret`, каждый секрет
не короче 32 байт и отличается от webhook-секрета) и `VAULTER_COLLAB_JWT_ACTIVE_KID`, а также issuer
(`VAULTER_COLLAB_ISSUER` или `app.url`).


## collaboration-epoch-mismatch

`collaboration_epoch_mismatch` (409) — запись коллаборации пришла из комнаты старого поколения:
документ восстановили или заменили его JSON после открытия комнаты. Запись отвергнута, чтобы не
влить брошенную историю обратно; откройте документ в новой комнате. Хаб закрывает такую комнату
кодом 4409 `epoch_changed` и не повторяет запись.


## collaboration-seed-conflict

`collaboration_seed_conflict` (409) — хаб попытался сидировать состояние документа, у которого
оно уже есть (другой инстанс хаба успел первым). Второй сид отвергнут: оба слились бы в
задвоенный контент. Хаб загружает сохранённое состояние.


## collaboration-protocol-mismatch

`collaboration_protocol_mismatch` (409) — вызов хаба не нёс `X-Vaulter-Collab-Protocol: 2` или нёс другую версию. Ничего
не прочитано. Хаб и бэкенд должны говорить на одном протоколе: обновите отстающий (образ `vaulter-collaboration-hub` и
`vaulter-collaboration` выпускаются вместе). Хаб, увидевший этот ответ, останавливает durable-записи и показывает
`protocol` в `/readyz`, пока бэкенд снова не ответит `2xx`.


## collaboration-checkpoint-conflict

`collaboration_checkpoint_conflict` (409, retryable `after_refetch`) — компактация хаба проиграла compare-and-set:
`context.reason` — `lease` (поколение ему больше не принадлежит), `coverage` (покрываемого диапазона нет в журнале) или
`checkpoint_version` (раньше опубликован другой чекпоинт). Ничего не записано и не удалено. Хаб берёт lease заново.


## collaboration-update-mismatch

`collaboration_update_mismatch` (422) — обновление с этим `update_id` уже зафиксировано, но с другими байтами.
`update_id` называет ровно одно обновление; повтор обязан нести тот же payload. Клиент, переиспользующий id, ошибочен.


## collaboration-update-too-large

`collaboration_update_too_large` (413) — тело append, checkpoint или recheck (или его payload) больше лимита,
`vaulter-collaboration.limits.update_bytes` / `limits.request_bytes` / `max_state_bytes`; решается по длине до любого
декодирования. Ничего не записано. Держите обновления ниже лимитов или поднимите их вместе с
`VAULTER_COLLAB_MAX_UPDATE_BYTES`, `VAULTER_COLLAB_MAX_REQUEST_BYTES` и `VAULTER_COLLAB_MAX_DOCUMENT_BYTES` хаба.


## collaboration-draining

`collaboration_draining` (503, retryable `with_backoff`) — `vaulter:collaboration:drain` выставил флаг draining, поэтому
журнал отвергает новые обновления, пока сохранённые компактируются. Хаб хранит обновление и повторяет его. После
повторного включения модуля выполните `php artisan vaulter:collaboration:drain --release`; `vaulter:doctor` показывает
флаг как `collaboration.draining`.



## missing-jwt

Драйверу Hocuspocus нужен `firebase/php-jwt`, чтобы выпускать токены комнат. Выполните
`composer require firebase/php-jwt`.

