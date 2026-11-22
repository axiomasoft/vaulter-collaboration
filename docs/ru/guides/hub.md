# Руководство по Vaulter Collaboration Hub

Vaulter Collaboration Hub (`packages/hub`, образ `ghcr.io/axiomasoft/vaulter-collaboration-hub`) — переиспользуемый сервер совместного редактирования (Hocuspocus + Yjs), конфигурируемый исключительно через переменные окружения и работающий на **Node.js >= 26.13.1 LTS**.

## 1. Требования к рантайму и контейнеру

- **Node.js:** `>= 26.13.1` LTS (закрывает High-CVE в HTTP/2 `CVE-2026-12386`, `llhttp`, `undici`).
- **Нативная библиотека `libatomic`:** для запуска Node 26 LTS в контейнере обязательна установка `libatomic`:
  - Debian/Ubuntu (`bookworm-slim` / `trixie`): `apt-get install -y --no-install-recommends libatomic1 libstdc++6`
  - Alpine: `apk add --no-cache libatomic libstdc++`
  - Каждый Dockerfile обязан содержать smoke-проверку `RUN node -e "process.exit(0)"`.
- **Зависимости:** `@hocuspocus/server >= 4.9.0`, `yjs >= 13.6.33`, `lib0 >= 0.2.119`, `@tiptap/core >= 3.34.0` (100% пермиссивные лицензии MIT/Apache-2.0/ISC).

## 2. Жизненный цикл `protocol=2` и бинарное хранение

1. **Аутентификация (`onAuthenticate`):** проверка Room Capability JWT (`sub`, `tenant_id`, `document_id`, `epoch`, `role`) и Origin allowlist (защита от CSWSH).
2. **Загрузка (`onLoadDocument`):** получение последнего бинарного снимка и хвоста `bytea`-обновлений от Laravel (`protocol=2`). JSON-реконструкция `Y.Doc` запрещена.
3. **Запись (`onStoreDocument` / ledger):** добавление бинарных обновлений в `v_collaboration_updates` с идемпотентными квитанциями и проверкой `owner_fence`.
4. **Epoch Fencing:** при конфликте эпох от Laravel Hub закрывает клиентские соединения с кодом `4409` (или `4412` при нарушении строгого профиля) и выгружает `Y.Doc` из памяти.

## 3. Конфигурация (переменные окружения)

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `NODE_ENV` | `production` | В `production` обязательно задать `VAULTER_COLLAB_ALLOWED_ORIGINS` (защита от CSWSH). |
| `VAULTER_COLLAB_PORT` | `1234` | Порт WebSocket-сервера. |
| `VAULTER_COLLAB_MANAGEMENT_HOST` | `127.0.0.1` | Адрес прослушивания `/livez`, `/readyz`, `/metrics`. Не публиковать наружу. |
| `VAULTER_COLLAB_MANAGEMENT_PORT` | `1235` | HTTP-порт управления и метрик. |
| `VAULTER_BACKEND_URL` | — | Базовый URL приложения Laravel. |
| `VAULTER_API_PREFIX` | `api/vaulter` | Префикс маршрутов `collaboration/hub/*`. |
| `VAULTER_COLLAB_ALLOWED_ORIGINS` | — | Список разрешённых Origin через запятую (обязателен в production). |
| `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS` | `30000` | Лимит времени на сброс буфера обновлений при `SIGTERM`. |
| `VAULTER_COLLAB_SHUTDOWN_DESTROY_MS` | `5000` | Лимит времени на `destroy()` после сброса буфера. |

## 4. Воркер уплотнения и офлайн-восстановление

Команда `serve` по умолчанию запускает WebSocket-сервер и фоновый воркер уплотнения (compaction lease).

Для офлайн-уплотнения всех ожидающих комнат (например, при обслуживании или восстановлении после сбоя):
```bash
docker run --rm --env-file hub.env \
  ghcr.io/axiomasoft/vaulter-collaboration-hub:<version> \
  compact --pending --deadline=120
```
Код возврата `0` означает, что все комнаты уплотнены; код `1` выводит оставшиеся комнаты в `stderr`.

## 5. Строгий профиль `3.5` и наблюдаемость

- **Строгий профиль `3.5`:** не использовать `@hocuspocus/extension-redis` для данных документов и `DirectConnection.transact`; не создавать `Y.UndoManager` на серверном `Y.Doc`.
- **Пробы здоровья:** `GET http://127.0.0.1:1235/livez` (liveness) и `/readyz` (readiness).
- **OpenTelemetry:** передавать `traceparent` на каждую логическую мутацию (не привязывать к многочасовому спану HTTP 101 Upgrade); собственные атрибуты задавать в пространстве `vaulter.*`.
- **Корректное завершение:** задавайте `terminationGracePeriodSeconds` больше суммы `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS + VAULTER_COLLAB_SHUTDOWN_DESTROY_MS`.
