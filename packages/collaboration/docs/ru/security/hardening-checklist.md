# Укрепление защиты

- [ ] Совместная работа, если включена: хаб по `wss://`, `jwt_keys` (каждый ≥ 32 байт, с существующим `jwt_active_kid`), отличные от `webhook_secret`, `token_ttl` ≤ 300 с, общий `drain.cache_store`, management-порт хаба закрыт от публичных сетей (`collaboration.hub`).
