#!/usr/bin/env node
/**
 * Portal entrypoint: `ide-portal --config <portal.yaml> [--web <dir>]
 * [--state <dir>]`. Fail-loud on any configuration problem; the process then
 * listens and resumes any Jenkins build the marker directory names (N3).
 * @module
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPortalConfig } from './config.ts'
import { createIamClient } from './auth.ts'
import { createJenkinsClient } from './jenkins.ts'
import { Orchestrator } from './orchestrator.ts'
import { createPortalServer } from './server.ts'

/** Parse `--flag value` pairs into a record. */
function flags(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key !== undefined && key.startsWith('--') && value !== undefined) out[key.slice(2)] = value
  }
  return out
}

async function main(): Promise<void> {
  const parsed = flags(process.argv.slice(2))
  const configPath = parsed['config']
  if (configPath === undefined) throw new Error('usage: ide-portal --config <portal.yaml> [--web <dir>] [--state <dir>]')
  const config = loadPortalConfig(resolve(configPath))
  const here = fileURLToPath(new URL('.', import.meta.url))
  const webRoot = resolve(parsed['web'] ?? resolve(here, '../web'))
  const stateDir = resolve(parsed['state'] ?? '.ide-portal-state')
  const orchestrator = new Orchestrator(config, createJenkinsClient(config.jenkins), stateDir)
  const server = createPortalServer(config, orchestrator, createIamClient(config.iam), webRoot)
  const port = await server.listen()
  process.stdout.write(`ide-portal listening on ${config.bindHost}:${String(port)} (entry ${config.entryHost})\n`)
  // Re-attach to Jenkins builds still running from before a portal restart (N3).
  // A build that died mid-run resurfaces on the next enter; resume failure is not fatal at boot.
  for (const uid of orchestrator.resumable()) void orchestrator.resume(uid).catch(() => {})
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void server.close().then(() => { process.exit(0) })
    })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`ide-portal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
