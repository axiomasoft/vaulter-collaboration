---
title: Совместное редактирование
description: Совместное редактирование документов в реальном времени пакетом vaulter-collaboration на Yjs и хабе коллаборации — установка, конфиг vaulter-collaboration, протокол 2 с подтверждённой квитанцией, режимы buffered и durable, компактация, состояние pending, ревокация, drain и обвязка @vaulter/vue-collaboration.
outline: deep
---

# Совместное редактирование

Vaulter редактирует **узлы-документы** (`kind = document`, контент в агрегате `v_documents`) совместно в реальном
времени. Бесконфликтное слияние обеспечивает **Yjs**: бинарные обновления — **источник истины**, JSON TipTap —
проекция чекпоинта. Коллаборация — отдельный пакет, три части ставятся вместе:

| Часть | Что это |
|---|---|
| `axioma-studio/vaulter-collaboration` | Laravel-модуль (`Vaulter\Collaboration\`): драйвер Yjs, room-токен, протокол хаба, журнал обновлений, команды drain и prune. Opt-in. |
| `@vaulter/collaboration-hub` | Node-хаб (Hocuspocus + Yjs), поставляется образом `ghcr.io/axiomasoft/vaulter-collaboration-hub` — см. [Хаб коллаборации](./hub). |
| `@vaulter/vue-collaboration` | Браузерная часть: конверты обновлений, очередь повторов, статус сохранения — [ниже](#обвязка-фронтенда-vaulter-vue-collaboration). |

Пакет documents хранит агрегат, обслуживает эндпоинт сессии и policy доступа, предоставляет контракты
(`CollaborationProtocolDriver`, `SupportsCollaboration`); кода хаба в нём нет. Решение и
его причины — [ADR-0031](/adr/0031-collaboration-package-and-durability).

Активный модуль collaboration регистрирует драйвер Hocuspocus в типизированном слоте протокола с ключом `yjs`.
Глобального селектора `driver` и транспорта Reverb нет. Другие адаптеры используют собственные слоты протоколов;
см. [Протоколы коллаборации](/ru/extending/collaboration-protocols). Broadcast-каналы
комментариев и их проверки доступа сохраняются.

## Установка и включение

<!-- snippet: shell -->

```bash
composer require axioma-studio/vaulter-collaboration
```

Модуль **opt-in** (он открывает сетевой канал и требует секреты). Включите его и задайте URL хаба и оба секрета; активный
модуль без них не даёт приложению загрузиться, а `vaulter:doctor` называет, чего не хватает:

<!-- snippet: host -->

```php
// config/vaulter.php
'modules' => [
    'collaboration' => true,
],
```

```dotenv
VAULTER_COLLAB_URL=wss://collab.example.com
VAULTER_COLLAB_JWT_KEYS=k1:<32+ случайных символа>   # ключи room-токена kid:secret, только Laravel
VAULTER_COLLAB_JWT_ACTIVE_KID=k1                       # kid ключа подписи
VAULTER_COLLAB_WEBHOOK_SECRET=<другое случайное>       # общий с хабом, подписывает каждый вызов хаба
```

`php artisan migrate` создаёт таблицы модуля (`v_collaboration_heads`, `v_collaboration_updates`,
`v_collaboration_receipts`, `v_collaboration_permission_versions`) и подключает его маршруты. Без модуля документы
редактируются по одному обычными эндпоинтами контента. Токены подписывает `firebase/php-jwt` — зависимость пакета.

## Конфигурация

Файл — `config/vaulter-collaboration.php` (тег публикации `vaulter-collaboration-config`):

<!-- snippet: config -->

```php
// config/vaulter-collaboration.php
return [
    'hub' => [
        'url' => env('VAULTER_COLLAB_URL', 'ws://localhost:1234'),
        'jwt_keys' => [/* kid => secret, from VAULTER_COLLAB_JWT_KEYS */],
        'jwt_active_kid' => env('VAULTER_COLLAB_JWT_ACTIVE_KID'),
        'issuer' => env('VAULTER_COLLAB_ISSUER'),
        'webhook_secret' => env('VAULTER_COLLAB_WEBHOOK_SECRET'),
        'token_ttl' => 300,
        'clock_skew' => 30,
        'timestamp_tolerance' => 300,
    ],
    'control' => [
        'transport' => env('VAULTER_COLLAB_CONTROL_TRANSPORT', 'none'),
    ],
    'max_state_bytes' => 16777216,
    'mode' => env('VAULTER_COLLAB_MODE', 'buffered'),
];
```

| Ключ | Env | По умолчанию | Назначение |
|---|---|---|---|
| `hub.url` | `VAULTER_COLLAB_URL` | `ws://localhost:1234` | WebSocket-URL хаба для клиента (в продакшне `wss://`). |
| `hub.jwt_keys` | `VAULTER_COLLAB_JWT_KEYS` | *(не задан)* | Ключи room-токена, пары `kid:secret` (через запятую в окружении): HS256, каждый не короче 32 байт и отличается от webhook-секрета. Токен проверяется любым ключом набора, подписывается ключом `jwt_active_kid`. Только на стороне Laravel, у хаба его нет. |
| `hub.jwt_active_kid` | `VAULTER_COLLAB_JWT_ACTIVE_KID` | *(не задан)* | Kid ключа, которым подписываются новые и обновлённые токены; он обязан входить в `jwt_keys`. |
| `hub.issuer` | `VAULTER_COLLAB_ISSUER` | `app.url` | Точный `iss` room-токена из конфигурации сервера (не из Host запроса). |
| `hub.webhook_secret` | `VAULTER_COLLAB_WEBHOOK_SECRET` | *(не задан)* | Ключ HMAC-подписи тела каждого вызова хаба и канала control. Общий с хабом; каждый ключ JWT обязан отличаться от него — совпадение даёт `InvalidConfigurationException` при загрузке (этот секрет есть у хаба, и при совпадении он смог бы подписать room-токен любого пользователя). |
| `hub.token_ttl` | — | `300` | Срок жизни room-токена в секундах, от 1 до **300** (иначе `InvalidConfigurationException`). Ограничивает [экспозицию](#ревокация-и-граница-экспозиции) при потере control-сообщения. |
| `hub.clock_skew` | — | `30` | Допустимый сдвиг часов для `exp` токена, от 0 до 30 секунд — у хаба и у бэкенда. Не допуск подписи запроса. |
| `hub.timestamp_tolerance` | — | `300` | Допустимый сдвиг часов *подписанного вызова хаба* и окно защиты от повтора. |
| `control.transport` | `VAULTER_COLLAB_CONTROL_TRANSPORT` | `none` | Как смена прав сразу доходит до хабов: `redis`, `http` или `none`. |
| `control.redis.connection` | `VAULTER_COLLAB_CONTROL_REDIS` | `default` | Redis-соединение, публикующее в `vaulter:collab:control`. |
| `control.http.urls` | `VAULTER_COLLAB_CONTROL_URLS` | *(пусто)* | Management-URL хабов через запятую (`http://hub-1:1235`). |
| `control.http.timeout` | — | `2` | Секунд на один control POST. |
| `max_state_bytes` | — | `16777216` | Максимальный бинарный Yjs-state одного чекпоинта или seed (`413`). |
| `mode` | `VAULTER_COLLAB_MODE` | `buffered` | `buffered` или `durable` — [когда правка считается сохранённой](#сохранено-значит-квитанция). Здесь проверяется при загрузке; режим исполняет хаб по своему `VAULTER_COLLAB_MODE`, поэтому задайте оба одинаково. |
| `limits.update_bytes` | — | `1048576` | Максимальное декодированное Yjs-обновление одного append. |
| `limits.request_bytes` | — | `2097152` | Максимальное тело запроса append; проверяется до декодирования. |
| `compaction.trigger_updates` / `trigger_bytes` / `trigger_age` | — | `500` / `1048576` / `600` | Поколение подлежит компактации при стольких записях журнала, байтах или секундах с самой старой записи. Запрос drain подходит всегда. |
| `compaction.lease_ttl` | — | `60` | Секунд, на которые хаб берёт lease поколения. |
| `drain.restore_deadline` | — | `10` | Секунд, которые restore, REST replace, чтение контента или экспорт *pending*-документа ждут компактации хабом, прежде чем ответить `409 document_state_pending`. |
| `drain.cache_store` | — | `null` (store по умолчанию) | Cache-store флага draining; должен быть общим для всех PHP-процессов (не `array`/`null`). |
| `drain.max_append_tx` | — | `5` | Самая долгая транзакция append; drain сообщает итог не раньше этого срока после выставления флага. |
| `retention.retired_generation_days` | — | `7` | Дней, которые журнал и квитанции закрытого поколения живут после того, как мог прийти его последний токен и повтор. |
| `schedule.collaboration_prune` | — | `dailyAt:03:40` | Расписание `vaulter:collaboration:prune` (грамматика и переключатель `vaulter.schedule.enabled` те же, что у расписания ядра). |

Полный сгенерированный список — в [справочнике конфигурации](../reference/config.md). Имя комнаты —
`<prefix>.<driveId>.<nodeId>.<поколение>`, префикс — `vaulter-documents.broadcast.channel_prefix` (по умолчанию
`vaulter.documents`).

::: warning Коллаборация включается отдельно
Включите `vaulter.modules.collaboration` и задайте оба секрета — заданные и разные. Кэш защиты от повтора подписанных
вызовов и флаг draining живут в `Cache`-store приложения: в продакшне нужен общий для всех инстансов store (Redis,
database), а не `array` или `file`.
:::

## Сохранено значит квитанция

Синхронизация Yjs — **не** подтверждение сохранения. Протокол 2 разделяет *доставлено* и *сохранено*:

1. Клиент даёт каждому локальному Yjs-обновлению стабильный `update_id` (UUID), заворачивает его в *конверт*
   `{generation, update_id, sha256, binary}` и держит в ограниченной очереди повторов.
2. Хаб добавляет обновление в журнал вызовом `POST collaboration/hub/append`. Бэкенд проверяет права на этот момент,
   вставляет обновление и **квитанцию** в одной транзакции и ставит [pending-маркер](#компактация-и-состояние-pending)
   документа.
3. Только после commit хаб отвечает клиенту `{t: "ack", id, seq, g}`. Повтор того же `update_id` (переподключение, таймаут
   после commit) возвращает тот же `seq` и не создаёт вторую правку. Тот же `update_id` с другими байтами —
   `422 collaboration_update_mismatch`.

Редактор показывает правду: **synchronized** (подключён и в такте с хабом), **pending** (локальные правки без квитанции) и
**saved** (у каждого локального обновления есть квитанция). Отказ или переполнение очереди — **error**, но не saved.

| Режим | Правка доходит до других клиентов | Она *сохранена* | Недоступный бэкенд | Что теряет kill хаба |
|---|---|---|---|---|
| `buffered` (по умолчанию) | сразу, до append | после квитанции | pending-байты остаются в памяти, ограничены на комнату и на всё; за границей **все** комнаты перестают принимать записи, пока журнал не разгрузится | обновления без квитанции; RPO **не** ограничен debounce |
| `durable` | сразу, но подтверждается только после commit | после квитанции | пока append падают, записи останавливаются во всех комнатах; новые конверты отвергаются с `retry: true` и остаются в очереди клиента | ничего из подтверждённого |

Подтверждённая правка в обоих режимах лежит в базе. Память хаба ограничена `VAULTER_COLLAB_PENDING_BUDGET_BYTES` (все
комнаты) и `VAULTER_COLLAB_PENDING_ROOM_BUDGET_BYTES` (одна комната); хаб сообщает каждому соединению
`{t: "status", mode, writes: "open" | "stopped", reason}`, чтобы редактор показал причину остановки (`draining`,
`pending_budget`, `backend_unavailable`, `protocol_mismatch`, `document_too_large`).

Вызовы хаба к бэкенду повторяются с full jitter (база 100 мс, потолок 2 с, не более 5 попыток, 10 с в сумме, 2 с на
попытку; `Retry-After` ответа `429` учитывается). Сетевые ошибки, `5xx` и `429` повторяются; ошибки авторизации, валидации
и поколения — нет.

## Поколения: epoch

У каждого документа есть **поколение коллаборации** (`v_documents.collab_epoch`). Оно сдвигается, когда рабочее состояние
заменяют вне комнаты:

- `restore()` ревизии;
- `update()` коллаборативного документа, у которого уже есть Yjs-state (замена JSON через API/PHP — Yjs-state
  сбрасывается, следующая комната сидируется из нового JSON).

Поколение входит в имя комнаты, токен и каждое обновление. Это **ограждение хранилища**: append несёт своё поколение и
сравнивается с текущим под блокировками документа, поэтому обновление комнаты, открытой до restore, либо фиксируется до
него (и попадает в снимок restore), либо отвергается `409 collaboration_epoch_mismatch`. Квитанции закрытого поколения
хранятся окно повторов, затем их удаляет `vaulter:collaboration:prune`.

Хаб узнаёт о restore при следующем вызове по этой комнате и закрывает её кодом **4409** `epoch_changed`; клиенты открывают
новую сессию и **новый** `Y.Doc`.

## Поток подключения

```
Vue-клиент ──POST /api/vaulter/v1/documents/{node}/collaboration/session {schema_version?}──▶ Laravel
            ◀──────────────── CollaborationSession (room, epoch, mode, token) ─┘
            │
            ▼
      ws к хабу (…?protocol=2), имя документа = room, токен = room JWT
            │   onAuthenticate ─▶ POST v1/collaboration/hub/authenticate
            │   onLoadDocument ─▶ POST v1/collaboration/hub/load        (чекпоинт + зафиксированный хвост, или JSON для одноразового seed)
            │   каждое обновление ─▶ POST v1/collaboration/hub/append   (→ квитанция → ack клиенту)
            │   до истечения  ─▶ POST v1/collaboration/hub/renew
```

1. Клиент вызывает `POST {prefix}/v1/documents/{node}/collaboration/session` (`201`), при желании передавая
   `schema_version`, которую поддерживает редактор. Маршрут существует только при активном модуле; неактивный модуль
   отвечает `404`, а `409 collaboration_unavailable` — документированный ответ «здесь не предлагается».
2. `DocumentOperations::collaborationSession($document, $clientSchemaVersion)` находит узел, авторизует `View` (узел,
   который актор не видит, даёт `404 node_not_found`) и решает режим. Сессия **read-write**, только если выполнено всё:
   - у актора есть `Edit`;
   - тип документа установлен, а его контент читается без потерь в схеме, которую эта установка пишет;
   - версия схемы клиента отсутствует или равна версии типа;
   - диск активен (архивный диск — только чтение).
3. Драйвер выпускает [сессию](#дескриптор-сессии).

::: warning Подключайтесь с `protocol=2`
Хаб считает соединение, в URL которого нет `?protocol=2`, клиентом протокола 1 и делает его **read-only**. Встроенный
транспорт `@vaulter/vue-collaboration` открывает провайдер с `url` сессии как есть, поэтому, пока он сам не добавляет
параметр, передайте его через переопределение `createHocuspocusProvider` в `createCollaborationAdapter({ providers })`.
:::

### Дескриптор сессии

```json
{
  "driver": "hocuspocus",
  "room": "vaulter.documents.01JDRIVE.01JNODE.3",
  "node_id": "01JNODE",
  "drive_id": "01JDRIVE",
  "epoch": 3,
  "schema_version": 1,
  "mode": "rw",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "url": "wss://collab.example.com"
}
```

Токен — HS256 JWT с claims `sub` (пользователь), `document_id`, `drive_id`, `tenant`, `generation`, `schema_version`,
`scope` (`read`|`write`), `permissions_version` (`{drive, global}`), `room`, `iat`, `exp` (= `iat` + `hub.token_ttl`) и
`jti`. Комната повторяет диск, документ и поколение, поэтому токен привязан к одному поколению одного документа.

## Протокол хаба (сервер-сервер)

Эндпоинты хаба живут под `{prefix}/v1/collaboration/hub/` на собственном стеке middleware (`routes.middleware.hub`,
`throttle:vaulter-public`) и не несут Laravel-аутентификации. Каждый вызов обязан говорить на **протоколе 2** —
заголовок `X-Vaulter-Collab-Protocol: 2`; иначе `409 collaboration_protocol_mismatch` до чтения тела — и каждый ответ его
повторяет. Эндпоинты существуют только при активном модуле.

- Вызовы комнаты (`authenticate`, `load`, `append`, `renew`) несут room-JWT в `Authorization: Bearer` (подпись и `exp`
  проверяются; комната должна совпадать с claims) **и** HMAC-SHA256 подпись `"{timestamp}.{rawBody}"` ключом
  `hub.webhook_secret` в `X-Vaulter-Collab-Timestamp` + `X-Vaulter-Collab-Signature`. Устаревшая метка времени и повтор
  подписи отвергаются; хаб кладёт в каждое тело случайный `nonce`.
- Собственные вызовы хаба (`compaction/lease`, `checkpoint`, `recheck`) касаются не одного соединения комнаты, поэтому их
  аутентифицирует одна подпись тела; `recheck` проверяет каждый токен, который называет.

Иначе — `401 actor_required` как `application/problem+json`. Любой отказ несёт стабильный problem `code`
([Ошибки](errors.md)). Каждый вызов перечитывает то, для чего выпущен токен: узел существует, не в корзине,
принадлежит диску и тенанту токена, поколение текущее, права субъекта — **на этот момент**.

| Эндпоинт | Использование хабом | Тело | Ответ |
|---|---|---|---|
| `POST collaboration/hub/authenticate` | `onAuthenticate` | `{ room }` | `{ allowed, mode, userId, epoch }`. |
| `POST collaboration/hub/load` | `onLoadDocument` | `{ room }` | `{ generation, schema_version, type, state_version, checkpoint, checkpoint_seq, head_seq, content, tail[] }` — base64-чекпоинт и зафиксированный хвост `(checkpoint_seq, head_seq]` для проигрывания; пока у поколения нет записей, `content` — JSON для seed. |
| `POST collaboration/hub/append` | каждое обновление | `{ room, generation, update_id, sha256, payload, origin?, seed_state_version? }` | Зафиксированная квитанция `{ generation, update_id, seq, sha256, persisted: true, permissions_stale }`. `503 collaboration_draining`, пока идёт drain. |
| `POST collaboration/hub/renew` | до `exp` | `{ room }` | Новый токен `{ token, room, generation, scope, mode, exp, jti, permissions_version }` по правам на этот момент. |
| `POST collaboration/hub/recheck` | после control-сообщения | `{ connections[] }` (до 200) | По каждому соединению `none` / `read` / `write` с причиной. |
| `POST collaboration/hub/compaction/lease` | воркер компактации | `{ hub_id, max? }` | До `max` lease: чекпоинт, версия, хвост и токен lease. |
| `POST collaboration/hub/checkpoint` | воркер компактации | `{ document, generation, lease_token, covered_from, covered_through, expected_checkpoint_version, state, content }` | `{ checkpoint_version, marker_cleared }` или `409 collaboration_checkpoint_conflict`. |

Правила `append`:

- права проверяются при **каждом** append; read-only токен, пользователь без `Edit` сейчас, архивный диск или другая версия
  схемы — `403`;
- payload больше `limits.update_bytes` или тело больше `limits.request_bytes` — `413 collaboration_update_too_large`,
  решается по длине до декодирования; `sha256` payload проверяется, ему не доверяют;
- **seed** хаба для пустого поколения — первая запись журнала; он несёт `seed_state_version` — `state_version`, который
  вернул `load`, и добавляется, только пока у поколения нет ни записей, ни чекпоинта, а версия состояния документа всё ещё
  равна ей, иначе `409 collaboration_seed_conflict` (два хаба никогда не сидируют оба, а REST-обновление между load и seed
  не затирается);
- `permissions_stale: true` в квитанции говорит хабу, что токен старше смены прав; сам append проверен по правам на этот
  момент.

### Когда бэкенд отказывает

Хаб никогда не считает отказанный append сохранённым. После повторов остаются ответы, которые повтор не изменит:

| Ответ | Смысл | Что делает хаб | Код закрытия (реакция клиента) |
|---|---|---|---|
| `409 collaboration_epoch_mismatch` / `collaboration_seed_conflict` | Поколение комнаты закончилось | Ограждает комнату, отбрасывает её следующие записи | **4409** `epoch_changed` — новая сессия, **новый** `Y.Doc` |
| `404` | Документ удалён | Ограждает комнату | **4404** `document_gone` |
| `401` | Токен писателя истёк | Закрывает комнату | **4001** `Collaboration token expired` — новая сессия, тот же `Y.Doc` |
| `403` | Писатель потерял `Edit` (или диск в архиве) | Закрывает соединение | **4403** `forbidden` — новая сессия (теперь read-only), тот же `Y.Doc` |
| `413`, `422` | Обновление слишком велико / невалидно | Отбрасывает запись, закрывает комнату | **4422** `store_refused` — клиент **не** переоткрывает; выставляется `error` |
| *(хаб останавливается)* | Хаб в drain | Останавливает записи, сбрасывает, закрывает | **4503** `draining` — переподключиться к другому хабу |

Конверт, который хаб не смог принять, получает `nack {id, code, retry}`; при `retry: true` он остаётся в очереди клиента.

### Загрузка и сидирование — только на хабе

`onLoadDocument` хаба проигрывает чекпоинт и зафиксированный хвост. Поколение без чекпоинта и журнала (новое или только
что восстановленное до ревизии без состояния) строится из JSON **один раз** на сервере через `@hocuspocus/transformer` и
схему TipTap хаба (`packages/collaboration/hub/src/schema.js`) и добавляется первой записью журнала до того, как его увидит
клиент. Seed fail-closed:

- **Ничего не режется молча.** ProseMirror отбрасывает атрибуты, которых нет в схеме. Документ, чей JSON схема хаба не
  вместит целиком — как правило, атрибут хоста, разрешённый `vaulter-documents.tiptap.extra_attributes` без соответствующего
  расширения хаба — отвергается (`seed refused` с именем `node.attribute`, но не значением). Добавьте расширение в хаб
  (см. [Хаб коллаборации](./hub)).
- **Первое read-only подключение ждёт.** Read-only подключение к документу без состояния отвергается — хаб не должен
  кэшировать пустой документ, который первый писатель затем спроецирует поверх сохранённого JSON.
- **Изменившийся документ сидируется заново.** На `collaboration_seed_conflict` хаб загружает заново (не более трёх
  попыток).

::: danger Никогда не сидируйте в клиенте
В коллаборативном режиме **не** вызывайте `setContent()` редактора (и не вставляйте JSON в `Y.Doc`). Два клиента,
конвертирующие один JSON, создают разные Yjs-вставки, и после слияния контент задвоится. По этой причине
`VaulterDocumentNode` передаёт редактору `content: null` в коллаборативном режиме.
:::

### Только чтение

Read-only обеспечивается дважды: хаб помечает `ro`-соединение read-only (Hocuspocus отбрасывает его обновления), а
бэкенд отвергает append под `read`-токеном. Когда токен истёк и не продлён, хаб отвергает любое сообщение и закрывает
соединение кодом `4001`; провайдер, переподключившийся с истёкшим токеном, получает отказ при аутентификации с причиной
`Collaboration token expired`, и клиент обновляет сессию.

## Компактация и состояние pending

Журнал только на добавление сворачивается в **чекпоинт** (слитый Yjs-state и его JSON-проекция, хранятся на документе
пакетом documents) хабом. PHP Yjs не мержит.

- Поколение с некомпактированными записями несёт **pending-маркер** на документе (`v_documents.pending_generation`,
  `pending_through_seq`): сохранённые правки лежат в журнале, а сохранённые JSON и бинарный чекпоинт устарели.
- Воркер компактации хаба берёт lease на подлежащие поколения (см. `compaction.*`), сливает чекпоинт и хвост и публикует
  одним compare-and-set; успех удаляет только payload этого поколения до покрытой последовательности и снимает маркер,
  когда он покрыт. Пришедший тем временем append остаётся; проигравшая компактация ничего не удаляет.
- Документ с маркером **никогда** не читается, не экспортируется и не заменяется из устаревшего состояния. Restore, REST
  replace, чтение контента, экспорт, `TrashOperations::purge`/`empty` сначала делают **drain**: хаб просят скомпактировать
  это поколение до `drain.restore_deadline` секунд. Если хаба нет или срок вышел, ответ `409 document_state_pending`
  (retryable `with_backoff`), и ничего не меняется: сохранённые квитанции не теряются, поколение остаётся открытым.
  Retention и шаг purge при удалении диска не могут сделать drain заранее: для pending-документа они отказывают тем же
  кодом, пока воркер не снимет маркер, а затем успешно проходят при следующем запуске.
- `vaulter.modules.collaboration = false`, выставленный напрямую, не компактирует, а закрывается fail-closed: только
  pending-документы отвечают `409 document_state_pending`. Используйте управляемый drain ниже.

Одноразовое восстановление без WebSocket-сервера (авария, окно обслуживания):

<!-- snippet: shell -->

```bash
docker run --rm --env-file hub.env ghcr.io/axiomasoft/vaulter-collaboration-hub:1 compact --pending --deadline=120
```

Код `0`: бэкенд сообщает, что подлежащих компактации поколений не осталось. Код `1`: срок вышел; pending-документы
перечислены в stderr, команду можно повторить. Код `2`: ошибка использования или конфигурации.

## Ревокация и граница экспозиции

Писатель, потерявший доступ, должен перестать писать. Drive фиксирует каждое изменение эффективных прав как durable-событие
`drive.access.effective_permissions_changed` (создание/отзыв grant, смена наследования, создание/отзыв/изменение/ротация
share, move/trash/restore/purge узла, archive/unarchive/delete диска); хост сообщает о смене роли, политики или тенанта
через `AccessInvalidation::changed()`. Модуль коллаборации в той же транзакции увеличивает монотонную версию прав диска
(или `global`), и дальше:

- каждый **append** проверяет права на этот момент; отозванный писатель сразу получает `403`;
- хаб **продлевает** токен до истечения (`VAULTER_COLLAB_RENEW_BEFORE_MS`, по умолчанию 60 с); продление снова проверяет
  права — потерявший `Edit` продлевается как read-only, без `View` — отказ и закрытие соединения;
- при `control.transport` = `redis` или `http` эфемерный consumer шлёт хабам **control-сообщение**, и они перепроверяют
  соединения этого диска (`none` → закрытие `4403`, `read` → read-only, `write` → без изменений). Проверка покрывает
  sync step 2, y-protocols updates и stateless-конверты. После повторного включения control-сообщения не проигрываются.

**Граница экспозиции.** Если control-сообщение потеряно (или `control.transport` = `none`), отозванный писатель
останавливается не позже `hub.token_ttl + hub.clock_skew` после выпуска его последнего токена — **330 с** по умолчанию.
Продление без проверки прав границу не сдвигает. При доставленном control-сообщении граница — время доставки плюс одна
перепроверка.

## Выключение модуля

Не удаляйте модуль, пока у документов есть сохранённые правки, которых нет в чекпоинте:

<!-- snippet: shell -->

```bash
php artisan vaulter:collaboration:drain --deadline=60
```

Команда выставляет флаг draining (каждый append отвечает `503 collaboration_draining`, retryable), просит хаб
скомпактировать все pending-документы и ждёт. Код `0`: pending-документов нет — переключите
`vaulter.modules.collaboration` в `false` или выполните `vaulter:module:uninstall collaboration`. Код `1`: документы всё
ещё pending (хаба нет, срок вышел); они перечислены, ничего не потеряно. `--release` снимает флаг; **после повторного
включения выполните его**, потому что флаг переживает активацию модуля и append отвечает `503`, пока он стоит
(`vaulter:doctor` сообщает `collaboration.draining`). `vaulter:module:uninstall collaboration` отказывает, пока есть маркер.

`vaulter:collaboration:prune [--dry-run]` удаляет журнал и квитанции закрытых поколений после льготного срока
(`hub.token_ttl` + горизонт повторов + `retention.retired_generation_days`); он запускается по расписанию ежедневно, см.
`schedule.collaboration_prune`.

## Эксплуатация хаба

Management-listener хаба (`/livez`, `/readyz`, `/metrics`, `/stats`, подписанный `POST /control`) и drain по `SIGTERM`
описаны в [Хабе коллаборации](./hub#management-listener). Проверка `vaulter:doctor` `collaboration.hub`
сообщает об отсутствующих или одинаковых секретах, URL не `wss://` в продакшне, сроке токена больше 300 с, непригодном
cache-store для drain и действующем drain.

Стенд сценариев отказа (kill после повтора, два хаба, drain по `SIGTERM`) — `scripts/collab-stand.sh`; ему нужен Docker, в
быстрый набор тестов он не входит. `scripts/collab-e2e.sh` — сквозной прогон с одним хабом.

## Обвязка фронтенда (`@vaulter/vue-collaboration`)

В `@vaulter/vue` Yjs нет: там определён шов (`VaulterCollaborationKey`, тип `CollaborationAdapter`) и REST-автосохранение.
Реализация реального времени — `@vaulter/vue-collaboration` (peer-зависимости `vue`, `yjs`, `@vaulter/vue`;
`@hocuspocus/provider` — его зависимость). Установите его и передайте плагину:

<!-- snippet: host -->

```ts
import { createApp } from 'vue'
import { VaulterPlugin } from '@vaulter/vue'
import { createCollaborationAdapter } from '@vaulter/vue-collaboration'

createApp(App).use(VaulterPlugin, {
  baseUrl: '/api/vaulter',
  collaboration: createCollaborationAdapter(),
})
```

При установленном адаптере `VaulterDocumentNode` открывает сессию для коллаборативных типов документов и возвращается к
REST-автосохранению **только** если запрос сессии ответил `404` или `409 collaboration_unavailable`. Без адаптера каждый
документ идёт по пути автосохранения.

`useCollaboration` из `@vaulter/vue-collaboration` запрашивает сессию, открывает `@hocuspocus/provider` поверх свежего
`Y.Doc`, ставит каждое локальное обновление в очередь как конверт до его ack и обрабатывает терминальные закрытия хаба:

- **4409 `epoch_changed`** — провайдер и старый `Y.Doc` уничтожаются, запрашивается новая сессия, а `doc` **заменяется**
  новым `Y.Doc`. Перепривяжите редактор; никогда не копируйте содержимое старого документа.
- **4001** (токен истёк) и **4403** `forbidden` (писатель потерял `Edit`; новая сессия приходит read-only) — запрашивается
  новая сессия; `Y.Doc` сохраняется, пока комната того же поколения.
- **4422** `store_refused` — бэкенд отверг само обновление, поэтому новая сессия снова будет отвергнута: ничего не
  переоткрывается, выставляется `error`, редактор остаётся read-only.

<!-- snippet: host -->

```ts
import { watch } from 'vue'
import { useCollaboration } from '@vaulter/vue-collaboration'
import { Editor } from '@tiptap/vue-3'
import Collaboration from '@tiptap/extension-collaboration'

const collab = useCollaboration(nodeId, { client, supportedSchemaVersion: 1 })
await collab.connect()

let editor = makeEditor()
// Restore заменил комнату: пересоберите редактор на новом документе.
watch(collab.doc, () => { editor.destroy(); editor = makeEditor() })

function makeEditor() {
  return new Editor({
    editable: !collab.readOnly.value,
    extensions: [Collaboration.configure({ document: collab.doc.value, field: 'default' })],
  })
}

// при размонтировании
collab.dispose()
```

| Член | Тип | Примечание |
|---|---|---|
| `doc` | `ShallowRef<Y.Doc>` | Документ для привязки; заменяется при `epoch_changed`. |
| `session` | `ShallowRef<NodeCollaborationSession \| null>` | Текущая сессия (комната, epoch, режим, версия схемы). |
| `status` | `Ref<'synchronized' \| 'pending' \| 'saved' \| 'error'>` | `saved` делает только ack бэкенда. |
| `connecting` / `connected` | `Ref<boolean>` | Рукопожатие идёт / живое соединение провайдера. |
| `readOnly` | `ComputedRef<boolean>` | `mode: 'ro'`, схема новее `supportedSchemaVersion` или сессия, не способная сберечь правки. |
| `schemaOutdated` | `Ref<boolean>` | Документ в более новой схеме, чем поддерживает редактор — попросите пользователя обновить приложение. |
| `collaborators` | `Ref<Collaborator[]>` | Удалённые участники из awareness. |
| `error` | `Ref<unknown>` | Любая ошибка запроса сессии или сохранения. |
| `connect()` / `disconnect()` / `dispose()` | | Сессия и провайдер / закрыть соединение, сохранив очередь / закрыть и сбросить очередь. |

По умолчанию очередь вмещает 1000 обновлений / 8 МиБ (`envelope: { maxQueuedUpdates, maxQueuedBytes }`); переполнение
переводит статус в `error`. Пакет экспортирует и строительные блоки: `createEnvelopeQueue`, `deriveStatus`, `sha256Hex`,
`fetchCollaborationSession` и `openCollaborationTransport`.

### `VaulterDocumentNode`

Когда выбранный обработчик коллаборативный (`capabilities.collaborative === true`), адаптер установлен и модуль активен,
`VaulterDocumentNode` открывает сессию и передаёт редактору `collaborative: true`, `content: null`, `ydoc` (заменяется
после restore — перепривяжите по изменению), присутствие и статус сохранения. Иначе используется путь автосохранения.

<!-- snippet: host -->

```vue
<VaulterDocumentNode
  :node="node"
  :supported-schema-version="1"
  @collaborating="(readonly) => { /* a session opened */ }"
  @schema-outdated="(version) => { /* ask the user to update the application */ }"
  @collaboration-failed="(error) => { /* the session could not be opened; the editor is read-only */ }"
/>
```

- `collaboration` (по умолчанию `true`) — `false` принудительно включает путь автосохранения.
- `supported-schema-version` — передаётся с запросом сессии; более новая схема документа открывается read-only и
  вызывает `schema-outdated`.
- Любой отказ сессии, кроме «не предлагается» (сеть, `429`, `5xx`, `403`), оставляет редактор **read-only** на
  загруженном контенте и вызывает `collaboration-failed`: автосохранение в документ с Yjs-state сдвинуло бы его поколение,
  сбросило состояние и выбросило бы всех остальных участников. Для повтора вызовите `load()` (экспонируется).

## Расширение

Транспорт — один шов: case `CollaborationDriverType` и реализация `CollaborationDriver` (контракт живёт в documents).
`issueSession($node, $epoch, $schemaVersion, $writable, $actorId)` лишь кодирует решение `collaborationSession()` и
никогда не авторизует.

## См. также

- [Хаб коллаборации](./hub)
- [Ошибки](errors.md) — `collaboration_*` и `document_state_pending`
- [ADR-0031 — Пакет коллаборации и модель сохранности](/adr/0031-collaboration-package-and-durability)
- [ADR-0001 — Транспорт коллаборации](/adr/0001-collaboration-transport)
- [Авторизация](/ru/guides/abilities) — как `View` / `Comment` / `Edit` соответствуют чтению и записи
