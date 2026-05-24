#!/usr/bin/env node
// arango-cli.mjs — CLI interface for mcp-arango-mind
// Usage:
//   node arango-cli.mjs                                    List active schema tools
//   node arango-cli.mjs --help                             Show active schema tools
//   node arango-cli.mjs arango_server_availability         Execute a tool
//   node arango-cli.mjs arango_server_availability format=json

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from './src/core.mjs'
import { loadEnv, resolveProfile } from './src/env.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)

// Boot core
loadEnv()
if (args.includes('--enterprise')) {
  process.stderr.write('--enterprise is not active in the schema-owned runtime yet; using arango/schema/arango.openapi.schema.json\n')
}
const configDir = join(__dirname, 'config')
const mcpSchema = JSON.parse(readFileSync(join(__dirname, 'mcp/schema/mcp.schema.json'), 'utf8'))
const toolsSchema = JSON.parse(readFileSync(join(__dirname, 'tools/schema/tools.schema.json'), 'utf8'))
const arangoSchema = JSON.parse(readFileSync(join(__dirname, 'arango/schema/arango.openapi.schema.json'), 'utf8'))
const profilesConfig = JSON.parse(readFileSync(join(configDir, 'profiles.json'), 'utf8'))
const profileName = args.find((_, i) => args[i - 1] === '--profile') || profilesConfig.default
const baseProfile = profilesConfig.profiles[profileName]
if (!baseProfile) { console.error(`Profile "${profileName}" not found`); process.exit(1) }
const profile = resolveProfile(baseProfile)
const toolsResolver = join(__dirname, 'tools/schema')
const core = createCore({ profile, mcpSchema, toolsSchema, arangoSchema, toolsResolver, logLevel: 'silent' })

// Filter out flags
const filtered = args.filter((arg, i) => {
  if (arg.startsWith('--')) return false
  if (args[i - 1] === '--profile') return false
  return true
})
const hasHelp = args.includes('--help') || args.includes('-h')

async function listTools() {
  const res = await core.handle({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
  for (const t of res.result.tools) {
    console.log(`  ${t.name.padEnd(30)} ${t.description || ''}`)
  }
}

// No tool name, or explicit help, lists active schema tools.
if (!filtered.length || hasHelp) {
  await listTools()
  core.close()
  process.exit(0)
}

// <tool> [key=value ...] → execute
const toolName = filtered[0]
const params = {}
for (const arg of filtered.slice(1)) {
  const eq = arg.indexOf('=')
  if (eq !== -1) {
    const key = arg.slice(0, eq)
    let val = arg.slice(eq + 1)
    try { val = JSON.parse(val) } catch {}
    params[key] = val
  }
}

const res = await core.handle({
  jsonrpc: '2.0', method: 'tools/call', id: 1,
  params: { name: toolName, arguments: params }
})

if (res.error) { console.error('Error:', res.error.message); core.close(); process.exit(1) }

const content = res.result?.content?.[0]?.text
if (res.result?.isError) { console.error(content); core.close(); process.exit(1) }

try { console.log(JSON.stringify(JSON.parse(content), null, 2)) } catch { console.log(content) }
core.close()
