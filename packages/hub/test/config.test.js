import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWebhookBase } from '../src/config.js'

// The webhook base URL the collaboration/hub calls live under.

test('derives the webhook base from backend URL + the default api prefix', () => {
  assert.equal(
    resolveWebhookBase({ VAULTER_BACKEND_URL: 'http://app' }),
    'http://app/api/vaulter/v1',
  )
})

test('respects a custom api prefix and strips stray slashes', () => {
  assert.equal(
    resolveWebhookBase({ VAULTER_BACKEND_URL: 'http://app/', VAULTER_API_PREFIX: '/v1/vaulter/' }),
    'http://app/v1/vaulter/v1',
  )
})

test('an explicit VAULTER_LARAVEL_WEBHOOK_URL wins over the derived base', () => {
  assert.equal(
    resolveWebhookBase({
      VAULTER_BACKEND_URL: 'http://ignored',
      VAULTER_LARAVEL_WEBHOOK_URL: 'https://collab.example.com/api/vaulter/v1/',
    }),
    'https://collab.example.com/api/vaulter/v1',
  )
})

test('falls back to localhost when nothing is configured', () => {
  assert.equal(resolveWebhookBase({}), 'http://localhost/api/vaulter/v1')
})

test('VAULTER_API_URL is the versioned base', () => {
  assert.equal(resolveWebhookBase({ VAULTER_API_URL: 'http://app/api/vaulter/v1/' }), 'http://app/api/vaulter/v1')
})

test('the explicit override wins over VAULTER_API_URL', () => {
  assert.equal(
    resolveWebhookBase({ VAULTER_API_URL: 'http://a/v1', VAULTER_LARAVEL_WEBHOOK_URL: 'http://b/v1' }),
    'http://b/v1',
  )
})
