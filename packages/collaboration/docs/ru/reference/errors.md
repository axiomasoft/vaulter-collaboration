# Частное дополнение: справочник

### `collaboration_checkpoint_conflict`

**409** · collaboration · retryable `after_refetch` · receipt `never`

**Конфликт контрольной точки совместной работы** — Журнал документа изменился с момента выдачи аренды компактации.


### `collaboration_draining`

**503** · collaboration · retryable `with_backoff` · receipt `never`

**Совместная работа завершается** — Совместная работа сбрасывает журнал перед отключением; обновление не сохранено, повторите позже.


### `collaboration_epoch_mismatch`

**409** · collaboration · retryable `after_refetch` · receipt `cacheable`

**Эпоха совместной работы устарела** — Сессия совместной работы устарела.


### `collaboration_protocol_mismatch`

**409** · collaboration · retryable `never` · receipt `never`

**Несовпадение протокола совместной работы** — Хаб совместной работы и сервер говорят на разных версиях протокола.


### `collaboration_seed_conflict`

**409** · collaboration · retryable `after_refetch` · receipt `cacheable`

**Конфликт начального состояния** — Начальное состояние документа задано другой сессией.


### `collaboration_update_mismatch`

**422** · collaboration · retryable `never` · receipt `never`

**Обновление совместной работы не совпадает** — Обновление не совпадает со своим хешем или с обновлением, уже сохранённым под тем же идентификатором.


### `collaboration_update_too_large`

**413** · collaboration · retryable `never` · receipt `never`

**Обновление совместной работы слишком велико** — Обновление совместной работы превышает допустимый размер.



## Дополнительные строки справочника

| [`collaboration_checkpoint_conflict`](#collaboration_checkpoint_conflict) | 409 | collaboration | `after_refetch` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationCheckpointConflictException` |
| [`collaboration_draining`](#collaboration_draining) | 503 | collaboration | `with_backoff` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationDrainingException` |
| [`collaboration_epoch_mismatch`](#collaboration_epoch_mismatch) | 409 | collaboration | `after_refetch` | `cacheable` | `Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException` |
| [`collaboration_protocol_mismatch`](#collaboration_protocol_mismatch) | 409 | collaboration | `never` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationProtocolMismatchException` |
| [`collaboration_seed_conflict`](#collaboration_seed_conflict) | 409 | collaboration | `after_refetch` | `cacheable` | `Vaulter\Collaboration\Exceptions\CollaborationSeedConflictException` |
| [`collaboration_update_mismatch`](#collaboration_update_mismatch) | 422 | collaboration | `never` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationUpdateMismatchException` |
| [`collaboration_update_too_large`](#collaboration_update_too_large) | 413 | collaboration | `never` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationUpdateTooLargeException` |
