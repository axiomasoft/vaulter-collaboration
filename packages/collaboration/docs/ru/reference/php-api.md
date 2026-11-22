# Частное дополнение: справочник

#### `Vaulter\Collaboration\Contracts\HostUserResolver`

Материализует пользователя хоста (`Authorizable`) по id, чтобы серверный вебхук совместного
редактирования (server-to-server) — который несёт лишь id пользователя, без сессии — мог
прогнать `AccessResolver` относительно реального актора. Возвращает `null`, когда id ни во
что не резолвится (тогда вебхук отвечает `allowed=false`, а не открывается наружу). По
умолчанию `Vaulter\Collaboration\HostUserResolver` делегирует настроенному auth user-provider;
привяжите свой, чтобы переопределить.

```php
interface HostUserResolver
{
    public function find(int|string $id): ?Authorizable;
}
```



## Дополнительные строки справочника

| Collaboration | `CollaborationDriver` (documents) | привязка в контейнере, `config('vaulter-collaboration.driver')` |
