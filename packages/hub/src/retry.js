// The one retry policy of hub → backend writes (protocol 2): full jitter, a bounded number of
// attempts and one deadline for the whole series, network time included. Only an answer that may
// change on its own is repeated — no answer at all (network error, attempt timeout), a 5xx and a
// 429 (after its Retry-After when that still fits the deadline). Authentication, validation and
// generation answers never change on a retry, so they end the series at once. The caller repeats
// the SAME request every time (an append keeps its update_id, sha256 and payload).
//
// Time is injected (clock, sleep, random) so tests drive the policy without real waits.

/** base 100 ms, cap 2 s, ≤ 5 attempts, a 10 s deadline for the series, 2 s per attempt. */
export const RETRY_DEFAULTS = Object.freeze({
  baseMs: 100,
  capMs: 2000,
  maxAttempts: 5,
  deadlineMs: 10_000,
  attemptTimeoutMs: 2000,
})

/** The policy from the hub config (retry* keys), falling back to the defaults. */
export function retryPolicy(conf = {}) {
  return {
    baseMs: conf.retryBaseMs ?? RETRY_DEFAULTS.baseMs,
    capMs: conf.retryCapMs ?? RETRY_DEFAULTS.capMs,
    maxAttempts: conf.retryMaxAttempts ?? RETRY_DEFAULTS.maxAttempts,
    deadlineMs: conf.retryDeadlineMs ?? RETRY_DEFAULTS.deadlineMs,
    attemptTimeoutMs: conf.retryAttemptTimeoutMs ?? RETRY_DEFAULTS.attemptTimeoutMs,
  }
}

/**
 * Full jitter: a uniformly random wait in [0, min(cap, base · 2^attempt)), attempt counted from 0
 * (the wait before the second attempt uses attempt 0).
 */
export function fullJitterDelay(attempt, { baseMs, capMs }, random = Math.random) {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt)

  return Math.floor(random() * ceiling)
}

/**
 * A Retry-After header in milliseconds: delta seconds or an HTTP date; null when absent or
 * unreadable. A date in the past is 0.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }

  const trimmed = value.trim()

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000
  }

  const at = Date.parse(trimmed)

  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/**
 * Whether one attempt's outcome may be repeated: `{ kind: 'network' }` (no answer, timeout),
 * or an answer with a 5xx or 429 status.
 */
export function isRetryable(outcome) {
  if (outcome?.kind === 'network') {
    return true
  }

  const status = outcome?.status

  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599)
}

/**
 * Run `attempt({ attempt, timeoutMs })` under the policy. `attempt` resolves an answer
 * `{ status, retryAfterMs?, ... }` and throws when there is none (network error, abort on its
 * timeout). Resolves `{ outcome, attempts, exhausted }`:
 *   - `outcome` is the last answer, or `{ kind: 'network', error }`;
 *   - `exhausted` is true when the series stopped on a retryable outcome (attempts or deadline
 *     used up, or a Retry-After beyond the deadline) — the caller keeps the request for later.
 * A 2xx or a non-retryable answer ends the series with `exhausted: false`.
 */
export async function withRetry(attempt, {
  policy = RETRY_DEFAULTS,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  onRetry = () => {},
} = {}) {
  const deadline = clock() + policy.deadlineMs
  let outcome = null
  let attempts = 0

  for (let index = 0; index < policy.maxAttempts; index++) {
    const remaining = deadline - clock()

    if (remaining <= 0) {
      break
    }

    attempts = index + 1

    try {
      outcome = await attempt({ attempt: index, timeoutMs: Math.min(policy.attemptTimeoutMs, remaining) })
    } catch (error) {
      outcome = { kind: 'network', error }
    }

    if (!isRetryable(outcome)) {
      return { outcome, attempts: index + 1, exhausted: false }
    }

    if (index + 1 >= policy.maxAttempts) {
      return { outcome, attempts: index + 1, exhausted: true }
    }

    const wait = outcome.status === 429 && Number.isFinite(outcome.retryAfterMs)
      ? outcome.retryAfterMs
      : fullJitterDelay(index, policy, random)

    // The next attempt must start (and get some time) before the deadline; a Retry-After the
    // deadline cannot honour ends the series now instead of being cut short.
    if (clock() + wait >= deadline) {
      return { outcome, attempts: index + 1, exhausted: true }
    }

    onRetry({ attempt: index, wait, outcome })
    await sleep(wait)
  }

  return { outcome: outcome ?? { kind: 'network', error: new Error('retry deadline reached before the first attempt') }, attempts, exhausted: true }
}
