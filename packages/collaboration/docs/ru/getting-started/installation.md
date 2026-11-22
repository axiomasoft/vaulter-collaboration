# Частное дополнение: справочник

## 3. Совместное редактирование (опционально)

Редактирование в реальном времени состоит из трёх частей: Laravel-модуля `axioma-studio/vaulter-collaboration`, Node-хаба
(`@vaulter/collaboration-hub`, образ `ghcr.io/axiomasoft/vaulter-collaboration-hub`) и браузерного пакета
`@vaulter/vue-collaboration`. Модуль **opt-in**: включите его в `config/vaulter.php` и задайте URL хаба и два разных
секрета, иначе приложение с активным модулем не загрузится:

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
VAULTER_COLLAB_WEBHOOK_SECRET=<другое случайное>       # общий с хабом
```

Запустите хаб из опубликованного образа (compose-файл — `packages/collaboration/hub/docker-compose.yml`) и установите
браузерный пакет:

<!-- snippet: shell -->

```bash
docker run -d --name vaulter-collab -p 127.0.0.1:1234:1234 \
  -e VAULTER_BACKEND_URL=https://app.example.com \
  -e VAULTER_COLLAB_ALLOWED_ORIGINS=https://app.example.com \
  -e VAULTER_COLLAB_WEBHOOK_SECRET="$VAULTER_COLLAB_WEBHOOK_SECRET" \
  ghcr.io/axiomasoft/vaulter-collaboration-hub:1
npm install @vaulter/vue-collaboration yjs
```

Хаб нужен при включённом совместном редактировании. Конфигурация, протокол, режимы сохранности, выключение модуля и
обвязка фронтенда — в [Совместном редактировании](../guides/collaboration.md); контракт окружения хаба, management-эндпоинты
и остановка — в [Хабе коллаборации](../guides/hub.md).


