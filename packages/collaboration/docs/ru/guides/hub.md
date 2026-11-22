# Хаб коллаборации (Docker)

Node-сервис, на котором работает **совместное редактирование документов** Vaulter в реальном времени (Yjs/TipTap),
`@vaulter/collaboration-hub` (`packages/collaboration/hub`). Это Hocuspocus плюс протокол 2 Vaulter: он загружает комнату
из журнала обновлений бэкенда, добавляет каждое обновление через бэкенд и подтверждает только зафиксированную квитанцию.
Laravel-сторона — модуль `axioma-studio/vaulter-collaboration`; установка, конфиг `vaulter-collaboration` и модель
сохранности описаны в [Совместном редактировании](./collaboration).

> **Reverb — не транспорт коллаборации.** Laravel Reverb — общая шина вещания (уведомления, присутствие, активность).
> Совместное редактирование работает на этом хабе; коллаборативный драйвер `reverb` удалён.

Хаб рассчитан на использование как **внешний переиспользуемый образ** — один опубликованный образ обслуживает много
проектов. Вы **ссылаетесь** на него, настраиваете его целиком переменными окружения и никогда не копируете исходники в
приложение:

```yaml
services:
  vaulter-collab:
    image: ghcr.io/axiomasoft/vaulter-collaboration-hub:1   # в продакшне закрепите @sha256:…
    ports: ["127.0.0.1:1234:1234"]   # только loopback — поставьте перед ним TLS reverse proxy
    environment:
      VAULTER_BACKEND_URL: "https://app.example.com"
      VAULTER_COLLAB_ALLOWED_ORIGINS: "https://app.example.com"
      VAULTER_COLLAB_WEBHOOK_SECRET: "<hub.webhook_secret из Laravel>"
    stop_grace_period: 40s   # больше суммы лимитов flush и destroy при остановке
    restart: unless-stopped
```

Образ **не привязан к бэкенду**: он аутентифицирует и сохраняет, обращаясь обратно в *ваше* Laravel-приложение, поэтому один
образ работает во всех проектах, встраивающих Vaulter. Git-тег образа — `vaulter-collaboration-hub-v*`, workflow —
`.github/workflows/collaboration-hub-image.yml`.

## Как это устроено

```
 браузер (писатель/читатель) ──ws(token = room JWT, doc = имя комнаты, ?protocol=2)──▶  хаб
        │                                  onConnect → allowlist Origin (CSWSH)
        │                                  onAuthenticate ─POST /v1/collaboration/hub/authenticate─┐
        │                                  onLoadDocument ─POST /v1/collaboration/hub/load─────────┤
        │                                  каждое обновление ─POST /v1/collaboration/hub/append────┤
        │                                  продление токена ─POST /v1/collaboration/hub/renew──────┤
        │                                  компактация ─POST …/compaction/lease, …/checkpoint──────┤
        └──── POST /api/vaulter/v1/documents/{node}/collaboration/session ──▶ Laravel ◀────────────┘
                                                 журнал + квитанции (v_collaboration_*), чекпоинт (v_documents)
```

1. Клиент вызывает `POST /api/vaulter/v1/documents/{node}/collaboration/session` и получает сессию: комнату
   `<prefix>.<driveId>.<nodeId>.<поколение>`, режим (`rw`|`ro`) и room-JWT.
2. Он открывает WebSocket к хабу с JWT как **токеном**, комнатой как именем документа и `protocol=2` в query. Соединение
   без `protocol=2` — клиент протокола 1, оно делается read-only.
3. Хаб проверяет `Origin`, затем спрашивает `authenticate`. Отказ закрывает сокет; `mode: ro` делает соединение read-only
   (Hocuspocus отбрасывает его обновления).
4. `onLoadDocument` спрашивает `load`: чекпоинт и зафиксированный хвост, которые хаб по порядку проигрывает в комнату.
   Для поколения без записей он строит Y.Doc из JSON **один раз** через `@hocuspocus/transformer` и `src/schema.js` и
   добавляет его первой записью журнала с `state_version`, который загрузил (документ, обновлённый между этими шагами,
   отвечает `409 collaboration_seed_conflict` и загружается заново). Клиенты не сидируют никогда. Seed, который что-либо
   потерял бы, отвергается (см. раздел про схему), а read-only первое подключение к несидированному документу
   отвергается, пока писатель его не засидирует.
5. Каждое обновление, которое нужно сохранить, проходит через **pending-журнал** хаба: *конверт* клиента
   `{t: "u", v: 2, g, id, h, b}` (поколение, `update_id`, sha256, base64-обновление) проверяется, применяется к комнате и
   добавляется под `update_id` клиента; серверные и прямые изменения получают собственный id и добавляются один раз;
   изменения, пришедшие через Redis, добавляет хаб, который получил их от своего клиента. Клиент получает
   `{t: "ack", id, seq, g}` после commit либо `{t: "nack", id, code, retry}`. Sync-шаги и y-protocols-обновления не
   подтверждаются никогда — клиент повторяет неподтверждённое обновление конвертом с тем же id.
6. Ответ `409` по поколению (был restore) терминален для комнаты: код закрытия **4409** `epoch_changed`, следующие записи
   отбрасываются, клиенты переоткрывают документ с новым Y.Doc. `404` закрывает с `4404`; сетевые ошибки, `5xx`,
   `408`/`425`/`429` повторяются (full jitter, 5 попыток, 10 с). Любой другой отказ — **не** сохранение: `401` закрывает
   с `4001`, `403` — с `4403` `forbidden`, `413`/`422` — с `4422` `store_refused`. Коды закрытия и реакция клиента на
   каждый — в [Совместном редактировании](./collaboration#когда-бэкенд-отказывает).
7. Каждый вызов подписан (HMAC точного тела ключом `VAULTER_COLLAB_WEBHOOK_SECRET`, с меткой времени и случайным nonce) и
   несёт `X-Vaulter-Collab-Protocol: 2`; вызовы комнаты несут ещё и room-JWT, который бэкенд требует.

Хабу **не нужен** секрет подписи JWT — токен выпускает Laravel и проверяет при каждом вызове. Хаб никогда не логирует
токены. До истечения токена хаб продлевает его через бэкенд (`VAULTER_COLLAB_RENEW_BEFORE_MS`); отказ в продлении
закрывает соединение с `4001`. Переподключение с уже истёкшим токеном отвергается при аутентификации с причиной
`Collaboration token expired`, и клиент обновляет сессию.

### Компактация

Хаб сворачивает журнал в чекпоинты — PHP Yjs не мержит. Воркер внутри `serve` каждые
`VAULTER_COLLAB_COMPACTION_INTERVAL_MS` спрашивает у бэкенда подлежащие поколения (`compaction/lease`), сливает чекпоинт и
хвост в Y.Doc вне какой-либо транзакции БД и публикует результат (`checkpoint`, один compare-and-set). Тот же образ
запускает воркер один раз, без WebSocket-сервера, для **офлайн-восстановления**:

<!-- snippet: shell -->

```bash
docker run --rm --env-file hub.env ghcr.io/axiomasoft/vaulter-collaboration-hub:1 compact --pending --deadline=120
```

Ему нужны только `VAULTER_COLLAB_WEBHOOK_SECRET` и URL бэкенда (портов и allowlist origin нет). Код `0`: бэкенд сообщает,
что подлежащих компактации поколений не осталось; код `1`: срок (по умолчанию 60 с) вышел, pending-документы перечислены
в stderr (id документа, поколение, последний исход), команду можно повторить; код `2`: ошибка использования или
конфигурации, к бэкенду ничего не обращалось. `vaulter:collaboration:drain` делает подлежащими сразу все pending-поколения.

### Схема TipTap хаба

`src/schema.js` перечисляет расширения TipTap, с которыми хаб сидирует и проецирует: StarterKit, Link, Image и Table для
`vaulter/rich-text`; подмножество Markdown для `vaulter/markdown`. Она обязана совпадать с allow-list бэкенда —
`test/schema-parity.test.js` сравнивает её с `packages/documents/tests/Fixtures/tiptap-schema.json` по узлам, меткам
**и атрибутам** (то, что расширение сериализует, включая `null`, должно быть разрешено бэкендом). Хост, добавляющий узлы
или атрибуты через `vaulter-documents.tiptap.extra_*`, добавляет и соответствующие расширения в `src/schema.js`.

Это обеспечено fail-closed. ProseMirror молча отбрасывает всё, чего нет в его схеме, поэтому хаб проверяет каждый seed:
если схема потеряла бы что-то из JSON документа (разрешённый атрибут `textAlign` без расширения TextAlign, например), seed
**отвергается** с `Collaboration seed refused: … would drop paragraph.textAlign …` — только имена атрибутов, не значения, —
и комната не открывается, вместо того чтобы сохранить урезанный документ. Зарегистрируйте расширение в `extensionsFor` — и
комната откроется. Тип документа, схемы которого у хаба нет, засидировать нельзя (соединение отвергается, пока у документа
нет Yjs-state).

## Контракт окружения

Вся конфигурация — переменные окружения (12-factor; секретов в образе нет). Хаб **проверяет конфигурацию при старте и
падает сразу**, если в продакшне не хватает обязательных значений или число задано некорректно. Командная строка —
`vaulter-collaboration-hub serve` (по умолчанию в образе) или `compact --pending`.

### Подключение

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VAULTER_COLLAB_PORT` | `1234` | Порт WebSocket, к которому подключаются клиенты (`ws(s)://host:PORT`). |
| `VAULTER_API_URL` | *(выводится)* | Версионированная база API, которую вызывает хаб, например `https://app.example.com/api/vaulter/v1`. **Должна заканчиваться на `/v1`**: база без него останавливает хаб при старте. |
| `VAULTER_BACKEND_URL` | `http://localhost` | Базовый URL вашего Laravel-приложения, в которое обращается хаб. **Обязателен в продакшне.** |
| `VAULTER_API_PREFIX` | `api/vaulter` | Префикс маршрутов Vaulter. Вызовы разрешаются в `{BACKEND}/{PREFIX}/v1/collaboration/hub/{authenticate,load,append,renew,recheck,compaction/lease,checkpoint}`. |
| `VAULTER_LARAVEL_WEBHOOK_URL` | *(выводится)* | Явная полная база (…/v1); перекрывает все перечисленные выше (reverse proxy / раздельные хосты). |
| `VAULTER_COLLAB_WEBHOOK_SECRET` | *(не задан)* | Ключ HMAC-подписи каждого вызова бэкенда и `POST /control`. Должен совпадать с Laravel `vaulter-collaboration.hub.webhook_secret`; сам секрет не отправляется. Обязателен: без него каждый вызов отвергается. |
| `VAULTER_COLLAB_WEBHOOK_TIMEOUT_MS` | `10000` | Таймаут запроса к бэкенду. |

### Сохранение (протокол 2)

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VAULTER_COLLAB_MODE` | `buffered` | `buffered` или `durable` — [когда правка сохранена](./collaboration#сохранено-значит-квитанция). Поведение задаёт значение хаба; Laravel `vaulter-collaboration.mode` (проверяется при загрузке) задайте таким же. |
| `VAULTER_COLLAB_PENDING_BUDGET_BYTES` | `67108864` (64 МиБ) | Pending-байты (без commit) всех комнат, после которых записи останавливаются во всех комнатах. |
| `VAULTER_COLLAB_PENDING_ROOM_BUDGET_BYTES` | `8388608` (8 МиБ) | Pending-байты одной комнаты, после которых записи останавливаются. |
| `VAULTER_COLLAB_FLUSH_INTERVAL_MS` | `1000` | Цикл сброса журнала, повторяющий append, чья серия повторов провалилась. |
| `VAULTER_COLLAB_RETRY_BASE_MS` / `_CAP_MS` | `100` / `2000` | База и потолок full-jitter backoff серии повторов append. |
| `VAULTER_COLLAB_RETRY_MAX_ATTEMPTS` | `5` | Попыток в одной серии. |
| `VAULTER_COLLAB_RETRY_DEADLINE_MS` | `10000` | Срок одной серии с учётом времени сети. |
| `VAULTER_COLLAB_RETRY_ATTEMPT_TIMEOUT_MS` | `2000` | Таймаут одной попытки; не больше срока. |
| `VAULTER_COLLAB_COMPACTION_INTERVAL_MS` | `2000` | Как часто воркер просит compaction lease. Запрос drain ждёт не дольше этого срока плюс один merge. |
| `VAULTER_COLLAB_COMPACTION_BATCH` | `10` | Сколько поколений может выдать один вызов lease (1–100). |

### Лимиты

Проверяются до любого декодирования; отказ учитывается в `collab_limit_rejections_total`.

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VAULTER_COLLAB_MAX_UPDATE_BYTES` | `1048576` | Одно Yjs-обновление (как `limits.update_bytes` бэкенда). |
| `VAULTER_COLLAB_MAX_DOCUMENT_BYTES` | `16777216` | Yjs-state одной комнаты (как `max_state_bytes`); не меньше лимита обновления. |
| `VAULTER_COLLAB_MAX_REQUEST_BYTES` | `2097152` | Тело одного запроса к бэкенду (как `limits.request_bytes`); должно вмещать append максимального обновления. |
| `VAULTER_COLLAB_MAX_ROOMS_PER_TENANT` | `1000` | Открытых на этом хабе комнат одного тенанта. |
| `VAULTER_COLLAB_MAX_CONNECTIONS_PER_ROOM` | `100` | Соединений одной комнаты на этом хабе. |
| `VAULTER_COLLAB_MAX_UPDATES_PER_SECOND_PER_ROOM` | `200` | Записей в секунду, которые принимает одна комната. |

### Безопасность

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VAULTER_COLLAB_ALLOWED_ORIGINS` | *(пусто)* | **Защита от CSWSH.** Список ТОЧНЫХ браузерных origin через запятую. **Обязателен в продакшне** (без него хаб не стартует). `*` разрешает любой (только dev). Не-браузерный клиент (без `Origin`) разрешён всегда — это не вектор CSWSH, и он по-прежнему проходит вызов аутентификации. |
| `VAULTER_COLLAB_MAX_PAYLOAD_BYTES` | `16778240` (`MAX_DOCUMENT_BYTES` + 1 КиБ) | Максимальный размер WebSocket-кадра (100 МиБ по умолчанию у `ws` не используется никогда). Он обязан вмещать самое большое сообщение, допускаемое лимитами — sync step 2 целого документа или самый длинный конверт, — поэтому меньшее значение останавливает хаб при старте. |
| `VAULTER_COLLAB_THROTTLE` | `15` | Попыток подключения с одного IP до временного бана. |
| `VAULTER_COLLAB_THROTTLE_SECONDS` | `60` | Окно (секунды), за которое считаются попытки. |
| `VAULTER_COLLAB_BAN_TIME` | `5` | Длительность бана (минуты) после превышения. |

### Ревокация

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VAULTER_COLLAB_RENEW_BEFORE_MS` | `60000` | За сколько до `exp` токена хаб продлевает его через бэкенд; отказ в продлении закрывает соединение. |
| `VAULTER_COLLAB_CONTROL_TOLERANCE_SECONDS` | `300` | Насколько метка времени подписанного `POST /control` может отличаться от текущей (как `hub.timestamp_tolerance` бэкенда). |
| `VAULTER_COLLAB_CONTROL_REDIS_URL` | `VAULTER_COLLAB_REDIS_URL` | Redis, в который бэкенд публикует control-сообщения (`vaulter:collab:control`). |

### Жизнеспособность / время жизни комнаты

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VAULTER_COLLAB_TIMEOUT_MS` | `30000` | Интервал heartbeat для мёртвых пиров. Согласуйте с idle-таймаутом балансировщика/прокси. |
| `VAULTER_COLLAB_DEBOUNCE_MS` | `5000` | Debounce Hocuspocus перед выгрузкой простаивающей комнаты. Это **не** интервал сохранения: сохранение — это append. |
| `VAULTER_COLLAB_MAX_DEBOUNCE_MS` | `30000` | Жёсткий потолок этого debounce. |

### Management-listener

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VAULTER_COLLAB_MANAGEMENT_HOST` | `127.0.0.1` | Адрес, на котором слушает management-listener. `0.0.0.0` — только для проб снаружи контейнера. |
| `VAULTER_COLLAB_MANAGEMENT_PORT` | `1235` | Его порт; должен отличаться от порта WebSocket. |
| `VAULTER_COLLAB_READY_BACKEND_TTL_MS` | `30000` | `/readyz` считает бэкенд доступным, пока его последний ответ `2xx` не старше этого срока; должен превышать интервал компактации. |

### Остановка

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS` | `30000` | Сколько pending-журнал может сбрасываться после `SIGTERM`. |
| `VAULTER_COLLAB_SHUTDOWN_DESTROY_MS` | `5000` | Сколько после этого может длиться `destroy()` Hocuspocus. Grace-период оркестратора должен превышать их сумму. |

### Масштабирование / эксплуатация

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `VAULTER_COLLAB_REDIS_URL` | *(не задан)* | Если задан, включает расширение Redis для **мульти-инстансной** синхронизации документа и awareness. Принимает полный URL `redis://`/`rediss://` (авторизация, TLS, db). |
| `VAULTER_COLLAB_INSTANCE_NAME` | `vaulter-hocuspocus` | Уникальное имя инстанса (корреляция логов; обязательно для Redis fan-out). |
| `VAULTER_COLLAB_QUIET` | `true` | Подавить стартовый баннер. |
| `VAULTER_COLLAB_LOG` | `false` | Включить расширение Logger (многословно; на масштабе выключено). |
| `NODE_ENV` | `production` | `production` ужесточает проверки (обязательны allowlist origin и URL бэкенда); продакшном считается всё, кроме `development`/`dev`/`test`/`local`. Опубликованный образ по умолчанию `production`; для локального стенда с открытыми origin задайте `development`. |

## Management-listener {#management-listener}

Хаб обслуживает эксплуатацию на отдельном listener, но не на порту WebSocket. Он слушает `VAULTER_COLLAB_MANAGEMENT_HOST`
(по умолчанию `127.0.0.1`: публичный ingress туда не ходит) и `VAULTER_COLLAB_MANAGEMENT_PORT` (по умолчанию `1235`).
Ничто здесь не аутентифицируется, кроме `POST /control`, поэтому держите listener вне публичных сетей.

| Путь | Ответ |
| --- | --- |
| `GET /livez` | `200`, пока отвечает event loop. Больше он ничего не читает — ни бэкенд, ни базу, ни Redis, — и очередь pending-обновлений его не краснит. Используйте как liveness-пробу и health check контейнера. |
| `GET /readyz` | `200` только пока слушает WebSocket-сервер, бэкенд ответил `2xx` в пределах `VAULTER_COLLAB_READY_BACKEND_TTL_MS` (heartbeat — вызов lease воркера компактации; сама проба ничего не вызывает), бэкенд говорит на протоколе 2, Redis готов, если настроен, и хаб не в drain. Иначе `503` со списком неуспешных проверок. **`503` не закрывает установленные сессии** — это делает drain. |
| `GET /metrics` | Текст Prometheus. Ни одна метрика не несёт комнату, документ или токен в метках. |
| `GET /stats` | `{rooms, connections}` в JSON. |
| `POST /control` | Control-сообщение бэкенда, подписанное как любой вызов хаба; без валидной подписи `401` и ничего не меняется, тело больше лимита — `413`. Используется при `vaulter-collaboration.control.transport = http`. |

Метрики (все с префиксом `collab_`): `ready`, `draining`, `writes_stopped`, `active_rooms`, `active_connections`,
`pending_updates`, `pending_bytes`, `pending_oldest_seconds`, `appended_total`, `append_retries_total`,
`append_failures_total`, `append_dropped_total`, `append_latency_seconds`, `epoch_mismatch_total`, `compaction_seconds`,
`compaction_failures_total`, `checkpoint_conflicts_total`, `control_messages_total`, `rechecks_total`,
`recheck_failures_total`, `token_renewals_total`, `token_renewal_failures_total`, `revoked_connections_total`,
`downgraded_connections_total`, `revoked_still_connected`, `limit_rejections_total`, `shutdown_unflushed`. Настройте
алерты на рост `collab_pending_oldest_seconds`, рост `collab_append_failures_total` и `collab_revoked_still_connected`
выше нуля.

## Корректная остановка (`SIGTERM`)

Хаб останавливается по `SIGTERM`/`SIGINT` одним координатором (собственный обработчик сигналов Hocuspocus выключен: его
`destroy()` не завершается, пока остаётся документ после неудачного store). По порядку, каждый шаг ограничен:

1. **Draining.** `/readyz` сразу отвечает `503`, новые соединения не принимаются; установившееся тем временем закрывается `4503`.
2. **Записи останавливаются** во всех комнатах (писатели становятся read-only; новые конверты отвергаются с
   `writes_stopped`, `retry: true` — клиент сохраняет их для хаба, к которому переподключится). Установленные соединения
   продолжают читать.
3. **Pending-журнал сбрасывается**, пока не опустеет или не пройдёт `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS`; воркер компактации
   останавливается.
4. **Каждое соединение закрывается `4503`** `draining`; клиенты переподключаются к другому хабу.
5. `destroy()` Hocuspocus выполняется не дольше `VAULTER_COLLAB_SHUTDOWN_DESTROY_MS`.
6. Если в журнале остались обновления, хаб логирует `{unflushed, documents, rooms}`, выставляет
   `collab_shutdown_unflushed` и завершается кодом `1`; иначе — кодом `0`.

Задайте оркестратору grace-период больше суммы лимитов flush и destroy (`stop_grace_period: 40s`,
`terminationGracePeriodSeconds`). Второй сигнал ничего не меняет.

## Безопасность в продакшне

- **Завершайте TLS на reverse proxy и отдавайте только `wss://`.** Хаб говорит на `ws`; поставьте перед ним nginx/Traefik,
  пробросьте WebSocket upgrade и заблокируйте plaintext. Держите read-таймаут прокси больше
  `VAULTER_COLLAB_TIMEOUT_MS`, чтобы он не рвал здоровые сокеты, но конечным.
- **Задайте `VAULTER_COLLAB_ALLOWED_ORIGINS`** точными origin вашего приложения. Никогда не используйте `*` в
  продакшне. (В `production` без него хаб не стартует.)
- **Держите `MAX_PAYLOAD` на уровне, нужном лимитам** — потолок кадра сдерживает DoS огромными сообщениями, но он обязан
  вмещать sync step 2 целого документа; чтобы снизить его, снизьте вместе с ним `VAULTER_COLLAB_MAX_DOCUMENT_BYTES`.
- **Room-JWT короткоживущий** (`token_ttl` ≤ 300 с) и привязан к одному поколению одного документа; каждый append
  перепроверяет доступ, поэтому читатель не может писать (хаб отбрасывает его обновления, бэкенд отвергает его append).
  Отозванного писателя останавливает control-сообщение или, самое позднее, срок `token_ttl + clock_skew` (по умолчанию 330 с) —
  см. [Ревокацию](./collaboration#ревокация-и-граница-экспозиции).
- **Никогда не открывайте порт WebSocket (1234) напрямую в интернет, а management-порт (1235) — вообще.** Привяжите порт
  WebSocket к loopback хоста / приватной сети и ходите к нему только через reverse proxy; `/metrics` забирайте только из
  приватной сети.
- **Per-IP throttle доверяет заголовкам прокси — прокси ОБЯЗАН их ставить.** Расширение Throttle берёт IP клиента из
  `X-Real-IP` / `X-Forwarded-For`, иначе — из адреса сокета. Клиент, дошедший до хаба напрямую, может подделать эти
  заголовки и полностью обойти бан за handshake-флуд. Поэтому reverse proxy должен **перезаписывать** (а не дополнять) оба
  заголовка реальным адресом клиента, а хаб не должен быть доступен иначе как через него.

Минимальный блок nginx для upgrade (обратите внимание на IP-заголовки — на них держится throttle):

```nginx
location /collab/ {
    proxy_pass http://vaulter-collab:1234/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # ПЕРЕЗАПИСЫВАЕМ IP клиента, чтобы подделанные X-Real-IP / X-Forwarded-For не обошли throttle.
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 75s;   # > heartbeat хаба, но конечный
}
```

Traefik делает это сам: `forwardedHeaders` учитывается только от `trustedIPs`, поэтому значение по умолчанию (не доверять
никому) заставляет Traefik переписывать `X-Forwarded-For`/`X-Real-IP` по реальному соединению. За любым прокси ограничьте
`trustedIPs`/`set_real_ip_from` самим прокси и не выставляйте хаб на публичные интерфейсы.

## Масштабирование (несколько инстансов)

Запустите несколько инстансов за балансировщиком и задайте `VAULTER_COLLAB_REDIS_URL`, чтобы клиенты на разных инстансах
сходились к одному документу через Redis pub/sub. Дайте каждому инстансу уникальный `VAULTER_COLLAB_INSTANCE_NAME`. Каждый
хаб добавляет обновления, полученные от своих клиентов, поэтому два хаба, сохраняющие несвязанные правки одного документа,
оба попадают в журнал.

> Redis здесь нужен **для межинстансной синхронизации и канала control, а не для хранения** — durable-состояние это журнал
> обновлений и чекпоинт бэкенда. Каждое сообщение обрабатывается на каждом инстансе, поэтому Redis даёт корректность/HA
> между узлами, а не пропускную способность. Если вы можете детерминированно направлять документ на один узел (sticky
> sessions / шардинг), этого fan-out можно избежать. Для `control.transport = http` перечислите management-URL каждого
> хаба в `vaulter-collaboration.control.http.urls`.

## Переиспользование между проектами

Образ намеренно не привязан к проекту. Направьте каждый деплой на собственный Laravel-бэкенд (`VAULTER_BACKEND_URL`) и
origin; один и тот же тег `ghcr.io/axiomasoft/vaulter-collaboration-hub` обслуживает их все. В продакшне закрепите digest
(`@sha256:…`), чтобы все потребители запускали один и тот же артефакт.

## Локальная разработка и стенды

Репозиторий поставляет исходники в `packages/collaboration/hub/` и `docker-compose.yml`, который может либо брать
опубликованный образ, либо собирать `build: .` из исходников. В `packages/collaboration/hub`: `npm run check`
(синтаксис), `npm test` (unit-набор `node:test` против заглушки бэкенда; работающий стенд не нужен). Два скрипта требуют
настоящий стек:

- `scripts/collab-e2e.sh` — `testbench serve` и один хаб: restore во время живой сессии, ack протокола 2, клиенты
  read-only и с устаревшей схемой; см. [`e2e/README.md`](https://github.com/axioma-studio/vaulter/tree/main/e2e).
- `scripts/collab-stand.sh` — Docker: PostgreSQL, Redis, хост и **два** хаба, затем сценарии отказа: бэкенд недоступен дольше
  срока повторов и `SIGKILL` всех хабов (каждое подтверждённое обновление восстанавливается), несвязанные правки,
  сохранённые на двух хабах одновременно, и `SIGTERM` во время набора текста (готовность падает сразу, квитанций после
  границы drain нет). Порты — `VAULTER_E2E_PORT`, `VAULTER_E2E_HUB_PORT` и `VAULTER_E2E_HUB_B_PORT` (management-listener
  каждого хаба на следующем порту), `VAULTER_STAND_MODE=buffered|durable`. Нужен Docker; в быстрый набор тестов он не входит.
