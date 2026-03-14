#!/usr/bin/env node
// arango-cli.mjs — CLI interface for mcp-arango-mind
// Usage:
//   node arango-cli.mjs                                    List all categories (tools/list)
//   node arango-cli.mjs Collections                        List actions in Collections
//   node arango-cli.mjs Collections --help                 Detailed help for each action (resources/read)
//   node arango-cli.mjs Collections listCollections        Execute action
//   node arango-cli.mjs Queries createAqlQueryCursor query="RETURN 1"

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from './src/core.mjs'
import { loadEnv, resolveProfile } from './src/env.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const configDir = join(__dirname, 'config')

const args = process.argv.slice(2)

// Boot core
loadEnv()
const mcpSchema = JSON.parse(readFileSync(join(configDir, 'mcp-schema.json'), 'utf8'))
const openapiFile = args.includes('--enterprise') ? 'arango-openapi.json' : 'arango-openapi-community.json'
const openapiSpec = JSON.parse(readFileSync(join(configDir, openapiFile), 'utf8'))
const connSchema = JSON.parse(readFileSync(join(configDir, 'arango-connection.json'), 'utf8'))
const profilesConfig = JSON.parse(readFileSync(join(configDir, 'profiles.json'), 'utf8'))
const profileName = args.find((_, i) => args[i - 1] === '--profile') || profilesConfig.default
const baseProfile = profilesConfig.profiles[profileName]
if (!baseProfile) { console.error(`Profile "${profileName}" not found`); process.exit(1) }
const profile = resolveProfile(baseProfile)
const core = createCore({ profile, mcpSchema, openapiSpec, connSchema, logLevel: 'silent' })

// Filter out flags
const filtered = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--profile')
const hasHelp = args.includes('--help') || args.includes('-h')

// No args → tools/list (all categories)
if (!filtered.length && !hasHelp) {
  const res = await core.handle({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
  for (const t of res.result.tools) {
    const count = t.description.match(/^(\d+) tools:/)?.[1] || ''
    console.log(`  ${t.name.padEnd(20)} ${count ? count + ' actions' : ''}`)
  }
  core.close()
  process.exit(0)
}

const category = filtered[0]
const action = filtered[1]

// <category> --help → resources/read for each action in category
if (hasHelp && category && !action) {
  // First get action list from category dispatch (no action = list)
  const listRes = await core.handle({
    jsonrpc: '2.0', method: 'tools/call', id: 1,
    params: { name: category, arguments: {} }
  })
  const content = listRes.result?.content?.[0]?.text
  if (listRes.result?.isError) { console.error(content); core.close(); process.exit(1) }
  const actions = JSON.parse(content)

  // Fetch help for each action via resources/read
  for (const a of actions) {
    const helpRes = await core.handle({
      jsonrpc: '2.0', method: 'resources/read', id: 2,
      params: { uri: `tool://help/${a.name}` }
    })
    const helpText = helpRes.result?.contents?.[0]?.text
    if (helpText) {
      const help = JSON.parse(helpText)
      const params = (help.parameters || [])
        .filter(p => p.name !== 'database-name')
        .map(p => `${p.required ? '*' : ' '}${p.name} (${p.type || '?'})`)
        .join(', ')
      console.log(`  ${help.name.padEnd(35)} ${help.summary || ''}`)
      if (params) console.log(`    ${params}`)
    }
  }
  core.close()
  process.exit(0)
}

// <category> (no action, no --help) → list actions
if (category && !action && !hasHelp) {
  const res = await core.handle({
    jsonrpc: '2.0', method: 'tools/call', id: 1,
    params: { name: category, arguments: {} }
  })
  const content = res.result?.content?.[0]?.text
  if (res.result?.isError) { console.error(content); core.close(); process.exit(1) }
  const actions = JSON.parse(content)
  for (const a of actions) {
    console.log(`  ${a.name.padEnd(35)} ${a.summary}`)
  }
  core.close()
  process.exit(0)
}

// <category> <action> [key=value ...] → execute
const params = {}
for (const arg of filtered.slice(2)) {
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
  params: { name: category, arguments: { action, ...params } }
})

if (res.error) { console.error('Error:', res.error.message); core.close(); process.exit(1) }

const content = res.result?.content?.[0]?.text
if (res.result?.isError) { console.error(content); core.close(); process.exit(1) }

try { console.log(JSON.stringify(JSON.parse(content), null, 2)) } catch { console.log(content) }
core.close()
