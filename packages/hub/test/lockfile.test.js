import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// The hub image is built from packages/hub alone (`npm ci` against packages/hub/package-lock.json), while
// CI tests the hub inside the root npm workspace (the root package-lock.json). The two lockfiles must
// resolve every package of the hub to the same version, or the image ships code the tests never ran.

function packages(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).packages
}

test('the hub lockfile resolves every package to the version the root workspace tests', () => {
  const hub = packages('../package-lock.json')
  const root = packages('../../../package-lock.json')
  const drift = []

  for (const [path, entry] of Object.entries(hub)) {
    if (!path.startsWith('node_modules/')) {
      continue
    }

    const tested = root[`packages/hub/${path}`] ?? root[path]

    if (tested?.version !== entry.version) {
      drift.push(`${path}: image ${entry.version}, tested ${tested?.version ?? 'absent'}`)
    }
  }

  assert.deepEqual(drift, [])
})
