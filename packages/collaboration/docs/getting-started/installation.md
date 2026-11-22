# Private add-on reference

## 3. Collaboration (optional)

Realtime editing is three pieces: the Laravel module `axioma-studio/vaulter-collaboration`, the Node hub
(`@vaulter/collaboration-hub`, the image `ghcr.io/axiomasoft/vaulter-collaboration-hub`) and the browser package
`@vaulter/vue-collaboration`. The module is **opt-in**: enable it in `config/vaulter.php` and give it the hub URL and
two different secrets, or the application refuses to boot with it active:

<!-- snippet: host -->

```php
// config/vaulter.php
'modules' => [
    'collaboration' => true,
],
```

```dotenv
VAULTER_COLLAB_URL=wss://collab.example.com
VAULTER_COLLAB_JWT_KEYS=k1:<32+ char random>           # room-token keys kid:secret, Laravel only
VAULTER_COLLAB_JWT_ACTIVE_KID=k1                       # the signing kid
VAULTER_COLLAB_WEBHOOK_SECRET=<another random>     # shared with the hub
```

Run the hub from the published image (the compose file is `packages/collaboration/hub/docker-compose.yml`) and install the
browser package:

<!-- snippet: shell -->

```bash
docker run -d --name vaulter-collab -p 127.0.0.1:1234:1234 \
  -e VAULTER_BACKEND_URL=https://app.example.com \
  -e VAULTER_COLLAB_ALLOWED_ORIGINS=https://app.example.com \
  -e VAULTER_COLLAB_WEBHOOK_SECRET="$VAULTER_COLLAB_WEBHOOK_SECRET" \
  ghcr.io/axiomasoft/vaulter-collaboration-hub:1
npm install @vaulter/vue-collaboration yjs
```

The hub is required when collaboration is enabled. The configuration, the protocol, the durability modes, switching the
module off and the frontend wiring are in [Realtime Collaboration](../guides/collaboration.md); the hub's environment contract,
management endpoints and shutdown are in [Collaboration hub](../guides/hub.md).


