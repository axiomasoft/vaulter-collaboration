import { createServer } from 'node:http'

// A programmable stand-in for the Laravel backend on a loopback port: it records every hub call
// (endpoint, headers, parsed body) and answers it from a per-endpoint handler. A handler returns
// { status, body?, headers?, delayMs?, hang? } — `hang` never answers (an attempt timeout), and a
// handler that throws resets the socket (a network error).

export async function startMockBackend(handlers = {}) {
  const calls = []
  const sockets = new Set()
  const routes = { ...handlers }

  const server = createServer((request, response) => {
    let raw = ''

    request.on('data', (chunk) => { raw += chunk })
    request.on('end', async () => {
      const endpoint = request.url.replace(/^.*\/collaboration\/hub\//, '')
      let body = null

      try {
        body = JSON.parse(raw)
      } catch {
        body = null
      }

      const call = { endpoint, headers: request.headers, body, raw }
      calls.push(call)
      const handler = routes[endpoint]

      if (typeof handler !== 'function') {
        response.writeHead(404, { 'Content-Type': 'application/problem+json' })
        response.end(JSON.stringify({ code: 'not_found' }))

        return
      }

      let answer

      try {
        answer = await handler(call, calls.filter((candidate) => candidate.endpoint === endpoint).length)
      } catch {
        request.socket.destroy()

        return
      }

      if (answer?.hang) {
        return
      }
      if (answer?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, answer.delayMs))
      }

      const status = answer?.status ?? 200
      response.writeHead(status, {
        'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json',
        ...(answer?.headers ?? {}),
      })
      response.end(JSON.stringify(answer?.body ?? {}))
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const webhookBase = `http://127.0.0.1:${port}/api/vaulter/v1`

  return {
    calls,
    port,
    /** The backend client options the persistence and backend.js take. */
    backendOptions: { config: { webhookBase, webhookSecret: 'test-secret', webhookTimeoutMs: 2000 } },
    on(endpoint, handler) {
      routes[endpoint] = handler
    },
    appends: () => calls.filter((call) => call.endpoint === 'append'),
    async close() {
      for (const socket of sockets) {
        socket.destroy()
      }

      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** A committed receipt for an append body, as the backend answers it. */
export function receipt(body, seq) {
  return {
    status: 200,
    body: { generation: body.generation, update_id: body.update_id, seq, sha256: body.sha256, persisted: true },
  }
}

/** A problem answer. */
export function problem(status, code, headers = {}) {
  return { status, body: { code }, headers }
}

/** A fake clock + sleep: sleeping advances the clock at once, so a 10 s deadline costs no time. */
export function virtualTime(start = 1_000_000) {
  let now = start
  const waits = []

  return {
    waits,
    clock: () => now,
    sleep: async (ms) => {
      waits.push(ms)
      now += ms
    },
    advance: (ms) => { now += ms },
  }
}
