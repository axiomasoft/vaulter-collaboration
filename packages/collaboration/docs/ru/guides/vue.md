# Частное дополнение: справочник

### Совместное редактирование

Редактирование в реальном времени находится не в `@vaulter/vue`: пакет определяет шов (`VaulterCollaborationKey`, типы
`CollaborationAdapter`, `CollaborationHandle` и `CollaborationStatus`) и путь REST-автосохранения. Установите
`@vaulter/vue-collaboration` и передайте `createCollaborationAdapter()` опцией `collaboration` в `VaulterPlugin`;
`VaulterDocumentNode` тогда открывает сессию для коллаборативных типов документов и возвращается к автосохранению только
когда модуль не предлагается (`404` или `409 collaboration_unavailable`). Его `useCollaboration(nodeId, { client,
supportedSchemaVersion, onEpochChanged })` запрашивает сессию (`documents.collaborationSession`), открывает провайдер
Hocuspocus на `Y.Doc`, который вы привязываете расширением Collaboration из TipTap, и сообщает статус сохранения
`status` (`synchronized`, `pending`, `saved`, `error` — `saved` делает только квитанция бэкенда). Содержимое всегда
приходит от хаба — не заполняйте редактор сами.

- `readOnly` истинно для сессии `ro` **или** если схема сервера новее `supportedSchemaVersion` (`schemaOutdated`):
  монтируйте редактор с `editable: false` и попросите пользователя обновить приложение.
- Когда хаб закрывает комнату кодом `4409 epoch_changed` (документ восстановили), старый `Y.Doc` уничтожается, его
  заменяют новые сессия и **новый** `Y.Doc`, после чего вызывается `onEpochChanged` — перечитайте содержимое и его ETag.
- `4001` (токен истёк) и `4403` (право на запись потеряно) обновляют сессию; `4422` не повторяется.

`connect()`, который перехватил другой `connect()`/`disconnect()`, отклоняется с `CollaborationCancelledError` — это не сбой сессии.
Обвязка, члены и очередь обновлений — в [Совместном редактировании](collaboration.md#обвязка-фронтенда-vaulter-vue-collaboration).


