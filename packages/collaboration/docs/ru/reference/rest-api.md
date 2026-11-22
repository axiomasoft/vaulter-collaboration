# Частное дополнение: справочник

### Эндпоинты хаба (сервер-к-серверу)

Вызовы хаба идут через стек `hub`: `throttle:vaulter-public`, заголовок протокола и проверки подписи ниже. Они
регистрируются, только пока активен модуль коллаборации, не принимают пользовательскую сессию и отвечают отказами как
problem+json (`401 actor_required` на неподписанный вызов). Каждый вызов обязан нести `X-Vaulter-Collab-Protocol: 2`
(иначе `409 collaboration_protocol_mismatch`), и каждый ответ его повторяет. Вызовы комнаты требуют room-JWT **и**
HMAC-подпись тела (`ResolveCollaborationCall`); собственные вызовы хаба (`compaction/lease`, `checkpoint`, `recheck`)
аутентифицирует одна подпись тела. Протокол — комната, ограждение по поколению, квитанция, seed,
`409 collaboration_epoch_mismatch` как терминальный ответ — описан в
[Совместном редактировании](../guides/collaboration.md#протокол-хаба-сервер-сервер).

| Маршрут | Имя | Ответ |
|---|---|---|
| `POST v1/collaboration/hub/authenticate` | `collaboration.hub.authenticate` | `{ allowed, mode, userId, epoch }` |
| `POST v1/collaboration/hub/load` | `collaboration.hub.load` | `{ generation, schema_version, type, state_version, checkpoint, checkpoint_seq, head_seq, content, tail[] }` |
| `POST v1/collaboration/hub/append` | `collaboration.hub.append` | зафиксированная квитанция `{ generation, update_id, seq, sha256, persisted, permissions_stale }`; `503 collaboration_draining`, пока идёт drain |
| `POST v1/collaboration/hub/renew` | `collaboration.hub.renew` | `{ token, room, generation, scope, mode, exp, jti, permissions_version }` |
| `POST v1/collaboration/hub/recheck` | `collaboration.hub.recheck` | `{ results: [{ id, access, reason, jti }] }` — `none`, `read` или `write` по каждому соединению |
| `POST v1/collaboration/hub/compaction/lease` | `collaboration.hub.compaction.lease` | массив lease: чекпоинт, версия, хвост и токен lease |
| `POST v1/collaboration/hub/checkpoint` | `collaboration.hub.checkpoint` | `{ checkpoint_version, marker_cleared }`; `409 collaboration_checkpoint_conflict` |

Маршрута сохранения всего состояния нет: сохранение — это `append` с квитанцией.

---


