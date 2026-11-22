# Частное дополнение: справочник

## `vaulter:collaboration:drain`

Делает модуль [коллаборации](../guides/collaboration.md) безопасным для выключения (opt-in модуль
`vaulter.modules.collaboration`). Команда выставляет флаг draining — с этого момента каждый append отвечает
`503 collaboration_draining` — просит воркер компактации хаба сделать чекпоинт каждого документа с pending-маркером и
ждёт вне транзакций, пока не останется ни одного либо не пройдёт `--deadline` секунд. Итог — то, что документы сообщают
потом, а не ответ хаба, и читается он не раньше `drain.max_append_tx` после выставления флага. Маркер, появившийся
тем временем, тоже сбрасывается.

```
vaulter:collaboration:drain
    {--deadline=30}   Секунд ждать, пока хаб сделает чекпоинт каждого pending-документа
    {--release}       Снять флаг draining: append снова принимаются
```

Код `0`: pending-документов нет — выключайте модуль или выполняйте `vaulter:module:uninstall collaboration`. Код `1`:
документы всё ещё pending (хаба нет, срок вышел) и перечислены, либо cache-store не сохранил флаг
(`vaulter-collaboration.drain.cache_store`), и хабу ничего не передано; повторите, когда хаб работает. Код `2`: неверная
опция. Флаг остаётся после обоих исходов до `--release`, **в том числе после повторного включения модуля**.

```bash
php artisan vaulter:collaboration:drain --deadline=60
php artisan vaulter:collaboration:drain --release
```

---


## `vaulter:collaboration:prune`

Удаляет журнал обновлений, квитанции и head закрытых поколений коллаборации после льготного срока: закрыто раньше, чем
`hub.token_ttl` + горизонт повторов хаба (10 с) + `retention.retired_generation_days`. Текущее поколение документа не
затрагивается. Сначала команда закрывает head поколений, которые документ покинул, пока модуль был выключен. Запускается по
расписанию ежедневно (`vaulter-collaboration.schedule.collaboration_prune`).

```
vaulter:collaboration:prune
    {--dry-run}   Показать, что было бы удалено, ничего не удаляя
```

```bash
php artisan vaulter:collaboration:prune --dry-run
```

---



## Дополнительные строки справочника

| `collaboration.hub` | При включённом модуле коллаборации: оба секрета заданы и различны, URL хаба (`wss://` в production), срок токена ≤ 300 с, cache-store флага drain общий для всех процессов; действующий флаг `vaulter:collaboration:drain` (`collaboration.draining`) — предупреждение | error → error |
| `vaulter-collaboration.schedule.collaboration_prune` | `vaulter:collaboration:prune` (нужен `vaulter.modules.collaboration`) | `dailyAt:03:40` |
