import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const directory = process.env.VAULTER_A42_BARRIERS
if (!directory) throw new Error('Missing test barrier directory')
const fetch = globalThis.fetch
let heldAppend = false
let heldCommit = false

globalThis.fetch = async function (url, options) {
  const endpoint = String(url)
  if (endpoint.endsWith('/collaboration/hub/append') && !heldAppend && typeof options?.body === 'string') {
    const { origin } = JSON.parse(options.body)
    if (origin === 'client') {
      heldAppend = true
      writeFileSync(join(directory, 'append-started'), '')
      while (!existsSync(join(directory, 'append-released'))) await setTimeout(20)
    }
  }
  const response = await fetch(url, options)
  if (endpoint.endsWith('/collaboration/hub/commands/settle') && response.ok && !heldCommit && typeof options?.body === 'string') {
    const { kind } = JSON.parse(options.body)
    if (kind === 'commit') {
      heldCommit = true
      writeFileSync(join(directory, 'commit-answered'), await response.clone().text())
      // The process gets SIGKILL after the test verifies the PHP commit.
      await new Promise(() => {})
    }
  }
  return response
}
