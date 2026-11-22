# Частное дополнение: справочник

## Broadcast / совместное редактирование не подключается {#collaboration}

**Симптом.** Редактор загружается, но синхронизация в реальном времени так и не подключается, либо
авторизация приватного канала отдаёт 403.

**Почему и решение.**

- **Модуль выключен.** Маршрут сессии отвечает `404` (или `409 collaboration_unavailable`), пока
  `vaulter.modules.collaboration` не `true`; `php artisan vaulter:modules` показывает его. С включённым модулем и без секрета или
  URL хаба приложение не загружается — `php artisan vaulter:doctor` называет находку (`collaboration.hub_*`).
- **401 от хаба.** Вызовам хаба нужны валидный room-JWT **и** HMAC-подпись тела. `401` обычно значит, что
  `VAULTER_COLLAB_WEBHOOK_SECRET` различается между Laravel (`vaulter-collaboration.hub.webhook_secret`) и хабом, либо часы
  расходятся больше, чем на `hub.timestamp_tolerance`.
- **409 `collaboration_protocol_mismatch`.** Хаб и бэкенд из разных релизов; см.
  [Ошибки](errors.md#collaboration-protocol-mismatch). `/readyz` хаба показывает `protocol: mismatch`.
- **Редактор подключился, но печатать нельзя (read-only).** Хаб делает read-only соединение без `?protocol=2` в URL;
  проверьте URL провайдера. Read-only также сессия с `mode: ro`, устаревшей схемой или статусом `error`.
- **Ввод остановился во всех документах («writes stopped»).** Хаб достиг pending-бюджета, бэкенд не отвечает или хаб в
  drain: смотрите `reason` сообщения `status` хаба и `collab_writes_stopped`, `collab_pending_oldest_seconds` в `/metrics`.
- **`/readyz` отдаёт 503, хотя хаб работает.** Это проверка готовности, а не liveness: бэкенд не отвечал `2xx` дольше
  `VAULTER_COLLAB_READY_BACKEND_TTL_MS`, Redis не готов или хаб в drain. Тело перечисляет неуспешную проверку; установленные
  сессии она не закрывает.
- **`409 document_state_pending`.** Сохранённые правки лежат в журнале, но ни один чекпоинт их не содержит, а хаб не
  успел скомпактировать их за `drain.restore_deadline`. Запустите хаб или выполните `compact --pending` образа хаба; см.
  [Компактацию и состояние pending](collaboration.md#компактация-и-состояние-pending).
- **`503 collaboration_draining` после повторного включения модуля.** Флаг draining, выставленный
  `vaulter:collaboration:drain`, переживает активацию: выполните `php artisan vaulter:collaboration:drain --release`.


