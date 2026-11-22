import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fullJitterDelay, isRetryable, parseRetryAfter, RETRY_DEFAULTS, retryPolicy, withRetry } from '../src/retry.js'
import { virtualTime } from './support/mock-backend.js'

// The hub → backend retry policy (protocol section): full jitter base 100 ms / cap 2 s, at most
// 5 attempts, one 10 s deadline for the series (network time included), 2 s per attempt; 429 waits
// its Retry-After when that fits the deadline; only network/5xx/429 are repeated. Time is virtual:
// no test waits for real.

function scripted(answers) {
  const calls = []

  return {
    calls,
    attempt: async (args) => {
      calls.push(args)
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)]

      if (answer instanceof Error) {
        throw answer
      }

      return typeof answer === 'function' ? answer(args) : answer
    },
  }
}

test('the defaults are the protocol\'s numbers', () => {
  assert.deepEqual({ ...RETRY_DEFAULTS }, { baseMs: 100, capMs: 2000, maxAttempts: 5, deadlineMs: 10_000, attemptTimeoutMs: 2000 })
  assert.deepEqual(retryPolicy({}), { ...RETRY_DEFAULTS })
  assert.deepEqual(retryPolicy({ retryBaseMs: 5, retryCapMs: 50, retryMaxAttempts: 3, retryDeadlineMs: 500, retryAttemptTimeoutMs: 40 }),
    { baseMs: 5, capMs: 50, maxAttempts: 3, deadlineMs: 500, attemptTimeoutMs: 40 })
})

test('full jitter draws below min(cap, base · 2^attempt)', () => {
  const policy = { baseMs: 100, capMs: 2000 }

  assert.equal(fullJitterDelay(0, policy, () => 0), 0)
  assert.equal(fullJitterDelay(0, policy, () => 0.999999), 99)
  assert.equal(fullJitterDelay(3, policy, () => 0.5), 400)
  // 100 · 2^5 = 3200 is capped at 2000.
  assert.equal(fullJitterDelay(5, policy, () => 0.999999), 1999)
  assert.equal(fullJitterDelay(10, policy, () => 0.5), 1000)
})

test('only no answer, 5xx and 429 are retryable', () => {
  assert.equal(isRetryable({ kind: 'network' }), true)

  for (const status of [500, 502, 503, 504, 429]) {
    assert.equal(isRetryable({ status }), true, `status ${status}`)
  }
  for (const status of [200, 400, 401, 403, 404, 408, 409, 413, 422, 425]) {
    assert.equal(isRetryable({ status }), false, `status ${status}`)
  }
})

test('Retry-After is read as seconds or as an HTTP date', () => {
  const now = Date.parse('2026-10-18T10:00:00Z')

  assert.equal(parseRetryAfter('3', now), 3000)
  assert.equal(parseRetryAfter(' 0 ', now), 0)
  assert.equal(parseRetryAfter('Sun, 18 Oct 2026 10:00:02 GMT', now), 2000)
  assert.equal(parseRetryAfter('Sun, 18 Oct 2026 09:00:00 GMT', now), 0)
  assert.equal(parseRetryAfter('soon', now), null)
  assert.equal(parseRetryAfter(null, now), null)
})

test('a success ends the series at once', async () => {
  const time = virtualTime()
  const backend = scripted([{ status: 200, ok: true }])
  const result = await withRetry(backend.attempt, { clock: time.clock, sleep: time.sleep })

  assert.deepEqual(result, { outcome: { status: 200, ok: true }, attempts: 1, exhausted: false })
  assert.deepEqual(time.waits, [])
})

for (const status of [400, 401, 403, 404, 409, 413, 422]) {
  test(`a ${status} is never repeated`, async () => {
    const time = virtualTime()
    const backend = scripted([{ status, code: 'x' }, { status: 200, ok: true }])
    const result = await withRetry(backend.attempt, { clock: time.clock, sleep: time.sleep })

    assert.equal(backend.calls.length, 1)
    assert.equal(result.exhausted, false)
    assert.equal(result.outcome.status, status)
  })
}

test('5xx and network errors are repeated with full jitter until a success', async () => {
  const time = virtualTime()
  const backend = scripted([{ status: 500 }, new TypeError('fetch failed'), { status: 503 }, { status: 200, ok: true }])
  const random = () => 0.5
  const result = await withRetry(backend.attempt, { clock: time.clock, sleep: time.sleep, random })

  assert.equal(result.exhausted, false)
  assert.equal(result.attempts, 4)
  assert.equal(result.outcome.status, 200)
  // 0.5 · min(2000, 100 · 2^n) for n = 0, 1, 2.
  assert.deepEqual(time.waits, [50, 100, 200])
})

test('at most five attempts, then the series is exhausted', async () => {
  const time = virtualTime()
  const backend = scripted([{ status: 502 }])
  const result = await withRetry(backend.attempt, { clock: time.clock, sleep: time.sleep, random: () => 0.1 })

  assert.equal(backend.calls.length, 5)
  assert.equal(result.attempts, 5)
  assert.equal(result.exhausted, true)
  assert.equal(result.outcome.status, 502)
  assert.equal(time.waits.length, 4)
})

test('the deadline covers the whole series, network time included', async () => {
  const time = virtualTime()
  // Every attempt takes 4 s of (virtual) network time and fails.
  const backend = scripted([async () => {
    time.advance(4000)

    return { status: 500 }
  }])
  const result = await withRetry(backend.attempt, { clock: time.clock, sleep: time.sleep, random: () => 0 })

  // 0 s, 4 s, 8 s: a fourth attempt would start at 12 s, past the 10 s deadline.
  assert.equal(backend.calls.length, 3)
  assert.equal(result.exhausted, true)
})

test('each attempt gets at most 2 s and never more than what is left of the deadline', async () => {
  const time = virtualTime()
  const backend = scripted([async () => {
    time.advance(3500)

    return { status: 503 }
  }])

  await withRetry(backend.attempt, { clock: time.clock, sleep: time.sleep, random: () => 0 })

  assert.deepEqual(backend.calls.map((call) => call.timeoutMs), [2000, 2000, 2000])
  const short = scripted([{ status: 503 }])
  const late = virtualTime()
  await withRetry(async (args) => {
    late.advance(9000)

    return short.attempt(args)
  }, { clock: late.clock, sleep: late.sleep, random: () => 0, policy: { ...RETRY_DEFAULTS, attemptTimeoutMs: 5000 } })
  // The first attempt took 9 s: the second one gets the remaining 1 s, not its own 5 s.
  assert.deepEqual(short.calls.map((call) => call.timeoutMs), [5000, 1000])
})

test('a 429 waits its Retry-After when it fits the deadline', async () => {
  const time = virtualTime()
  const backend = scripted([{ status: 429, retryAfterMs: 3000 }, { status: 200, ok: true }])
  const result = await withRetry(backend.attempt, { clock: time.clock, sleep: time.sleep, random: () => 0.5 })

  assert.equal(result.exhausted, false)
  assert.deepEqual(time.waits, [3000])
})

test('a 429 whose Retry-After lies beyond the deadline ends the series without waiting', async () => {
  const time = virtualTime()
  const backend = scripted([{ status: 429, retryAfterMs: 30_000 }, { status: 200, ok: true }])
  const result = await withRetry(backend.attempt, { clock: time.clock, sleep: time.sleep })

  assert.equal(backend.calls.length, 1)
  assert.equal(result.exhausted, true)
  assert.deepEqual(time.waits, [])
})

test('a 429 without Retry-After falls back to full jitter', async () => {
  const time = virtualTime()
  const backend = scripted([{ status: 429, retryAfterMs: null }, { status: 200, ok: true }])

  await withRetry(backend.attempt, { clock: time.clock, sleep: time.sleep, random: () => 0.5 })

  assert.deepEqual(time.waits, [50])
})

test('the attempt is repeated as is: the caller sends the same request every time', async () => {
  const time = virtualTime()
  const request = { update_id: '6f9619ff-8b86-4011-b42d-00c04fc964ff', sha256: 'ab'.repeat(32), payload: 'AQID' }
  const sent = []

  await withRetry(async () => {
    sent.push(JSON.stringify(request))

    return sent.length < 3 ? { status: 500 } : { status: 200, ok: true }
  }, { clock: time.clock, sleep: time.sleep })

  assert.equal(new Set(sent).size, 1)
  assert.equal(sent.length, 3)
})
