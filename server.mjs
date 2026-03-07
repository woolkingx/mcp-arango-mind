// server.mjs — Entry: parse args → load schemas → create core → attach transport

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createCore } from './core.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Parse CLI args
const args = process.argv.slice(2)
const useSSE = args.includes('--sse')
const debug = args.includes('--debug')

function getArg(flag) {
  const idx = args.indexOf(flag)
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null
}

const port = parseInt(getArg('--port') || '8000', 10)
const host = getArg('--host') || '127.0.0.1'
const profileName = getArg('--profile')
const auditFile = getArg('--audit')

// Load config files
const configDir = join(__dirname, 'config')
const mcpSchema = JSON.parse(readFileSync(join(configDir, 'mcp-schema.json'), 'utf8'))
const openapiSpec = JSON.parse(readFileSync(join(configDir, 'arango-openapi.json'), 'utf8'))
const profilesConfig = JSON.parse(readFileSync(join(configDir, 'profiles.json'), 'utf8'))

// Resolve profile
const name = profileName || profilesConfig.default
const profile = profilesConfig.profiles[name]
if (!profile) {
  process.stderr.write(`Profile "${name}" not found\n`)
  process.exit(1)
}

// Create core
const core = createCore({ profile, mcpSchema, openapiSpec, debug, auditFile })

// Attach transport
if (useSSE) {
  const { startSSE } = await import('./transports/sse.mjs')
  startSSE(core, { port, host })
} else {
  const { startStdio } = await import('./transports/stdio.mjs')
  startStdio(core)
}
