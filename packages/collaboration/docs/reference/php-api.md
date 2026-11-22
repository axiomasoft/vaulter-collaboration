# Private add-on reference

#### `Vaulter\Collaboration\Contracts\HostUserResolver`

Materialises a host user (`Authorizable`) by id, so the server-to-server
collaboration webhook — which carries only a user id, no session — can run the
`AccessResolver` against a real actor. Returns `null` when the id resolves to nothing
(the webhook then answers `allowed=false` rather than failing open). The default
`Vaulter\Collaboration\HostUserResolver` defers to the configured auth user-provider; bind
your own to override.

```php
interface HostUserResolver
{
    public function find(int|string $id): ?Authorizable;
}
```



## Additional reference rows

| Collaboration | `CollaborationDriver` (documents) | container binding, `config('vaulter-collaboration.driver')` |
