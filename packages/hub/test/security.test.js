import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConfig, isOriginAllowed, validateConfig } from '../src/config.js'

// CSWSH Origin allowlist + fail-fast config validation.

const prod = (extra = {}) => buildConfig({ NODE_ENV: 'production', VAULTER_BACKEND_URL: 'http://app', ...extra })
const dev = (extra = {}) => buildConfig({ NODE_ENV: 'development', ...extra })

test('a browser Origin on the allowlist is allowed (exact match)', () => {
  const conf = prod({ VAULTER_COLLAB_ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com' })
  assert.equal(isOriginAllowed('https://app.example.com', conf), true)
})

test('a browser Origin NOT on the allowlist is rejected', () => {
  const conf = prod({ VAULTER_COLLAB_ALLOWED_ORIGINS: 'https://app.example.com' })
  assert.equal(isOriginAllowed('https://evil.example.com', conf), false)
})

test('no substring/prefix bypass of the allowlist', () => {
  const conf = prod({ VAULTER_COLLAB_ALLOWED_ORIGINS: 'https://app.example.com' })
  assert.equal(isOriginAllowed('https://app.example.com.evil.com', conf), false)
  assert.equal(isOriginAllowed('https://app.example.com:1', conf), false)
})

test('a non-browser client (no Origin) is allowed — not a CSWSH vector, still auth-gated', () => {
  const conf = prod({ VAULTER_COLLAB_ALLOWED_ORIGINS: 'https://app.example.com' })
  assert.equal(isOriginAllowed(undefined, conf), true)
  assert.equal(isOriginAllowed('', conf), true)
})

test('"*" in the allowlist allows any Origin (explicit opt-in)', () => {
  const conf = prod({ VAULTER_COLLAB_ALLOWED_ORIGINS: '*' })
  assert.equal(isOriginAllowed('https://anything.example', conf), true)
})

test('dev with an empty allowlist allows any Origin (convenience)', () => {
  assert.equal(isOriginAllowed('http://localhost:5273', dev()), true)
})

test('production with an empty allowlist rejects a browser Origin (fail-closed)', () => {
  // (validateConfig also makes this combination fatal at boot — see below.)
  const conf = buildConfig({ NODE_ENV: 'production', VAULTER_BACKEND_URL: 'http://app' })
  assert.equal(isOriginAllowed('https://app.example.com', conf), false)
})

test('validateConfig: production requires a backend URL and an origin allowlist', () => {
  const problems = validateConfig(buildConfig({ NODE_ENV: 'production' }))
  assert.equal(problems.length, 2)
  assert.ok(problems.some((p) => p.includes('VAULTER_BACKEND_URL')))
  assert.ok(problems.some((p) => p.includes('VAULTER_COLLAB_ALLOWED_ORIGINS')))
})

test('validateConfig: a fully configured production hub is valid', () => {
  const problems = validateConfig(prod({ VAULTER_COLLAB_ALLOWED_ORIGINS: 'https://app.example.com' }))
  assert.deepEqual(problems, [])
})

test('validateConfig: dev needs no backend/origin config', () => {
  assert.deepEqual(validateConfig(dev()), [])
})

test('validateConfig: a non-positive maxPayload is rejected', () => {
  const problems = validateConfig(dev({ VAULTER_COLLAB_MAX_PAYLOAD_BYTES: '0' }))
  assert.ok(problems.some((p) => p.includes('VAULTER_COLLAB_MAX_PAYLOAD_BYTES')))
})

test('a non-canonical NODE_ENV is treated as production (fail-closed, not silently dev)', () => {
  for (const value of ['production ', ' production', 'Production', 'PRODUCTION', 'prod', 'staging', 'typo']) {
    assert.equal(buildConfig({ NODE_ENV: value }).isProduction, true, `NODE_ENV=${JSON.stringify(value)}`)
  }
  for (const value of ['development', 'dev', 'test', 'local', ' Development ']) {
    assert.equal(buildConfig({ NODE_ENV: value }).isProduction, false, `NODE_ENV=${JSON.stringify(value)}`)
  }
})

// Numeric env validation: a typo must fail fast at boot rather than silently boot a
// misconfigured hub (fail fast).

test('validateConfig: a malformed integer (trailing garbage / non-numeric) is rejected', () => {
  for (const bad of ['12a34', '4.5', 'abc', '0x10', '15 30']) {
    const problems = validateConfig(dev({ VAULTER_COLLAB_PORT: bad }))
    assert.ok(
      problems.some((p) => p.includes('VAULTER_COLLAB_PORT') && p.includes('valid integer')),
      `VAULTER_COLLAB_PORT=${JSON.stringify(bad)} should be flagged`,
    )
  }
})

test('validateConfig: a port outside 1..65535 is rejected', () => {
  assert.ok(validateConfig(dev({ VAULTER_COLLAB_PORT: '0' })).some((p) => p.includes('VAULTER_COLLAB_PORT')))
  assert.ok(validateConfig(dev({ VAULTER_COLLAB_PORT: '70000' })).some((p) => p.includes('VAULTER_COLLAB_PORT')))
})

test('validateConfig: the WS port and the management port must differ', () => {
  const problems = validateConfig(dev({ VAULTER_COLLAB_PORT: '1234', VAULTER_COLLAB_MANAGEMENT_PORT: '1234' }))
  assert.ok(problems.some((p) => p.includes('VAULTER_COLLAB_MANAGEMENT_PORT') && p.includes('must differ')))
})

test('the management listener binds loopback by default; an empty or invalid address or port is fatal', () => {
  assert.equal(dev().managementHost, '127.0.0.1')
  assert.equal(prod().managementHost, '127.0.0.1')
  assert.equal(dev().managementPort, 1235)
  assert.equal(dev({ VAULTER_COLLAB_MANAGEMENT_HOST: '0.0.0.0' }).managementHost, '0.0.0.0')
  assert.ok(validateConfig(dev({ VAULTER_COLLAB_MANAGEMENT_HOST: ' ' })).some((p) => p.includes('VAULTER_COLLAB_MANAGEMENT_HOST')))
  assert.ok(validateConfig(dev({ VAULTER_COLLAB_MANAGEMENT_PORT: '70000' })).some((p) => p.includes('VAULTER_COLLAB_MANAGEMENT_PORT')))
  assert.ok(validateConfig(dev({ VAULTER_COLLAB_READY_BACKEND_TTL_MS: '1500', VAULTER_COLLAB_COMPACTION_INTERVAL_MS: '2000' })).some((p) => p.includes('VAULTER_COLLAB_READY_BACKEND_TTL_MS')))
})

test('the retired health port is not configuration any more', () => {
  assert.equal('healthPort' in dev(), false)
  assert.deepEqual(validateConfig(dev({ VAULTER_COLLAB_HEALTH_PORT: '1234' })), [], 'an old variable is ignored, not validated')
})

test('validateConfig: a negative throttle window is rejected', () => {
  const problems = validateConfig(dev({ VAULTER_COLLAB_THROTTLE: '-1' }))
  assert.ok(problems.some((p) => p.includes('VAULTER_COLLAB_THROTTLE')))
})

test('validateConfig: a well-formed dev config with custom numerics stays valid', () => {
  const problems = validateConfig(dev({
    VAULTER_COLLAB_PORT: '2000',
    VAULTER_COLLAB_MANAGEMENT_PORT: '2001',
    VAULTER_COLLAB_THROTTLE: '30',
    VAULTER_COLLAB_THROTTLE_SECONDS: '120',
  }))
  assert.deepEqual(problems, [])
})

test('room claims retain typed principal and exact binding and reject malformed claims', async () => {
  const { roomTokenClaims } = await import('../src/tokens.js')
  const room = 'vaulter.documents.7.42.3'
  const base = { sub: '42', sub_type: 'staff', protocol: 'yjs', state_format: 'yjs-update-v1', schema_version: 1,
    generation: 3, document_id: '42', drive_id: '7', tenant: '0', scope: 'read', exp: 1300, room, jti: 'id' }
  const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
  assert.deepEqual(roomTokenClaims(jwt(base), room), base)
  for (const [key, value] of Object.entries({ sub_type: '', sub: 42, protocol: null, state_format: '', schema_version: 0,
    generation: 4, document_id: '43', drive_id: '8', tenant: 0, scope: 'owner', exp: 1.5, room: 'other' })) {
    assert.equal(roomTokenClaims(jwt({ ...base, [key]: value }), room), null, key)
  }
  for (const key of Object.keys(base)) {
    const missing = { ...base }
    delete missing[key]
    assert.equal(roomTokenClaims(jwt(missing), room), null, `missing ${key}`)
  }
})
