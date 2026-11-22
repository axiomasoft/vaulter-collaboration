# Private add-on reference

### Hub endpoints (server to server)

The hub's calls use the `hub` stack: `throttle:vaulter-public`, the protocol header and the signature checks below. They are
registered only while the collaboration module is active, never take a user session, and answer refusals as problem+json
(`401 actor_required` for a call that is not signed). Every call must carry `X-Vaulter-Collab-Protocol: 2`
(`409 collaboration_protocol_mismatch` otherwise) and every answer repeats it. Room calls require the room JWT **and** the HMAC
signature of the body (`ResolveCollaborationCall`); the hub's own calls (`compaction/lease`, `checkpoint`, `recheck`) are
authenticated by the body signature alone. The protocol — room, generation fence, the receipt, the seed,
`409 collaboration_epoch_mismatch` as a terminal answer — is in [Collaboration](../guides/collaboration.md#the-hub-protocol-server-to-server).

| Route | Name | Answers |
|---|---|---|
| `POST v1/collaboration/hub/authenticate` | `collaboration.hub.authenticate` | `{ allowed, mode, userId, epoch }` |
| `POST v1/collaboration/hub/load` | `collaboration.hub.load` | `{ generation, schema_version, type, state_version, checkpoint, checkpoint_seq, head_seq, content, tail[] }` |
| `POST v1/collaboration/hub/append` | `collaboration.hub.append` | the committed receipt `{ generation, update_id, seq, sha256, persisted, permissions_stale }`; `503 collaboration_draining` while a drain runs |
| `POST v1/collaboration/hub/renew` | `collaboration.hub.renew` | `{ token, room, generation, scope, mode, exp, jti, permissions_version }` |
| `POST v1/collaboration/hub/recheck` | `collaboration.hub.recheck` | `{ results: [{ id, access, reason, jti }] }` — `none`, `read` or `write` per connection |
| `POST v1/collaboration/hub/compaction/lease` | `collaboration.hub.compaction.lease` | an array of leases: checkpoint, version, tail and a lease token |
| `POST v1/collaboration/hub/checkpoint` | `collaboration.hub.checkpoint` | `{ checkpoint_version, marker_cleared }`; `409 collaboration_checkpoint_conflict` |

There is no whole-state store route: a save is an `append` with a receipt.

---


