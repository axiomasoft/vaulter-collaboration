# Частное дополнение: справочник

## Совместное редактирование в реальном времени

Источник истины — Yjs-обновления; JSON TipTap — проекция чекпоинта. Коллаборация — opt-in пакет `vaulter-collaboration`
([ADR-0031](/adr/0031-collaboration-package-and-durability); выбор транспорта —
[ADR-0001](/adr/0001-collaboration-transport)); documents хранит агрегат и контракт `CollaborationDriver`:

- **`hocuspocus`** — Node-хаб `@vaulter/collaboration-hub`. Клиент подключается с подписанным room JWT; хаб обращается в
  эндпоинты протокола 2 (`v1/collaboration/hub/{authenticate,load,append,renew,recheck}` и `lease`/`checkpoint`
  компактации). Сохранение — это `append`, возвращающий зафиксированную квитанцию; хаб сворачивает журнал в чекпоинт.
  Ни drive, ни documents от него не зависят. См. [Совместное редактирование](../guides/collaboration.md).



## Дополнительные строки справочника

| `axioma-studio/vaulter-collaboration` | `Vaulter\Collaboration\` | Совместное редактирование в реальном времени: эндпоинт сессии и room-токен, протокол хаба 2 (`authenticate`, `load`, `append`, `renew`, `recheck`, lease и checkpoint компактации), журнал обновлений, квитанции и версии прав (`v_collaboration_*`), команды drain и prune, control-consumer. Node-хаб `@vaulter/collaboration-hub` живёт в `packages/collaboration/hub`. Opt-in. |
| `@vaulter/vue-collaboration` | — | Браузерная часть коллаборации (npm): конверты обновлений, очередь повторов, статус сохранения; подключается к `@vaulter/vue` через его адаптер `collaboration`. Единственный пакет с `yjs` и `@hocuspocus/provider`. |
| `Vaulter\Documents\Contracts\CollaborationDriver` | `config('vaulter-collaboration.driver')` | [ADR-0001](/adr/0001-collaboration-transport), [ADR-0031](/adr/0031-collaboration-package-and-durability) |
