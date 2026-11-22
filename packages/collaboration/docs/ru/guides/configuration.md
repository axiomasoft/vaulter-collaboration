# Частное дополнение: справочник

## Коллаборация {#collaboration}

Редактирование в реальном времени — отдельный opt-in пакет `axioma-studio/vaulter-collaboration` с файлом конфигурации
`config/vaulter-collaboration.php` (тег публикации `vaulter-collaboration-config`). Он активен, только когда
`vaulter.modules.collaboration` равен `true`; тогда обязательны URL хаба (`hub.url`) и набор JWT-ключей (`hub.jwt_keys`, `hub.jwt_active_kid`) и webhook-секрет (
`hub.webhook_secret`, заданные и разные) — без них приложение не загружается. Ключи (`hub.*`, `control.*`, `mode`,
`limits.*`, `compaction.*`, `drain.*`, `retention.*`, `schedule.*`) перечислены в
[Совместном редактировании → Конфигурация](collaboration.md#конфигурация).


