// Headless 2-client Yjs smoke over the LIVE collab stack — Laravel (:8000) + Hocuspocus
// hub (:1234) — WITHOUT a browser. The fast feedback loop behind the Playwright e2e:
// it proves the same guarantees in ~6s and pinpoints transport/webhook breakage before
// the UI layer is involved.
//
// Asserts:
//   1) the room JWT is verified by the hub -> Laravel collab/authenticate webhook,
//   2) writer edits sync to the viewer (Yjs over the hub),
//   3) a read-only viewer's edits are DROPPED server-side (never reach the writer),
//   4) the debounced snapshot lands in v_node_document_versions.collab_state.
//
// Run (stack already up — see e2e/README.md):  node scripts/headless-smoke.mjs
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'

const BACKEND = process.env.VAULTER_BACKEND_URL ?? 'http://127.0.0.1:8000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function token(nodeId, user) {
  const res = await fetch(`${BACKEND}/api/vaulter/nodes/${nodeId}/collab/token`, {
    method: 'POST',
    headers: { 'X-E2E-User': String(user), Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`token(user=${user}) -> HTTP ${res.status}`)
  return (await res.json()).data
}

function connect(session, doc, label) {
  return new Promise((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url: session.url,
      name: session.room,
      token: session.token,
      document: doc,
      WebSocketPolyfill: WebSocket,
      onAuthenticationFailed: (d) => reject(new Error(`${label} auth failed: ${JSON.stringify(d)}`)),
      onSynced: () => resolve(provider),
    })
    setTimeout(() => reject(new Error(`${label} sync timeout`)), 8000)
  })
}

const scene = await (await fetch(`${BACKEND}/e2e/setup`)).json()
const node = scene.node_id
console.log('scene:', scene)

const w = await token(node, 1)
const v = await token(node, 2)
console.log(`token: writer.read_only=${w.read_only}  viewer.read_only=${v.read_only}`)

const dw = new Y.Doc()
const dv = new Y.Doc()
const pw = await connect(w, dw, 'writer')
const pv = await connect(v, dv, 'viewer')
console.log('both clients synced')

// 1) writer -> viewer propagation
dw.getText('content').insert(0, 'HELLO-FROM-WRITER')
await sleep(1500)
const seenByViewer = dv.getText('content').toString()

// 2) viewer (read-only) edit must NOT reach the writer (server drops it)
dv.getText('content').insert(0, 'SNEAKY-VIEWER-')
await sleep(1500)
const seenByWriter = dw.getText('content').toString()

// 3) debounced snapshot persisted
await sleep(3000)
const snap = await (await fetch(`${BACKEND}/e2e/snapshot/${node}`)).json()

const checks = {
  writer_writable: w.read_only === false,
  viewer_readonly: v.read_only === true,
  propagation: seenByViewer.includes('HELLO-FROM-WRITER'),
  readonly_enforced: !seenByWriter.includes('SNEAKY-VIEWER-'),
  persisted: snap.has_state === true,
}
const pass = Object.values(checks).every(Boolean)
console.log('snapshot:', snap)
console.log('checks:', checks)
console.log('\nRESULT:', pass ? 'PASS ✅' : 'FAIL ❌')

pw.destroy()
pv.destroy()
process.exit(pass ? 0 : 1)
