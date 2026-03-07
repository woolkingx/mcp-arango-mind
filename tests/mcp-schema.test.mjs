// Test 1: MCP protocol conformance — responses match MCP JSON Schema
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ObjectTree } from '../lib/schema2object.mjs'
import { createCore } from '../core.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const configDir = join(__dirname, '..', 'config')
const mcpSchema = JSON.parse(readFileSync(join(configDir, 'mcp-schema.json'), 'utf8'))
const openapiSpec = JSON.parse(readFileSync(join(configDir, 'arango-openapi.json'), 'utf8'))
const profilesConfig = JSON.parse(readFileSync(join(configDir, 'profiles.json'), 'utf8'))
const defs = mcpSchema.definitions

function mcpDef(name) {
  return { $ref: '#/definitions/' + name, definitions: defs }
}

function makeCore() {
  return createCore({
    profile: profilesConfig.profiles[profilesConfig.default],
    mcpSchema, openapiSpec, debug: false
  })
}

describe('MCP Schema Conformance', () => {

  it('initialize response matches InitializeResult schema', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'initialize', id: 1 })
    assert.equal(res.jsonrpc, '2.0')
    assert.equal(res.id, 1)
    assert.ok(res.result)
    // Schema validates: protocolVersion, capabilities, serverInfo (all required)
    const tree = new ObjectTree(res.result, mcpDef('InitializeResult'))
    assert.equal(tree.protocolVersion, '2025-03-26')
    assert.ok(tree.serverInfo)
    assert.ok(tree.capabilities)
  })

  it('tools/list response matches ListToolsResult schema', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'tools/list', id: 2 })
    assert.equal(res.jsonrpc, '2.0')
    assert.ok(res.result)
    const tree = new ObjectTree(res.result, mcpDef('ListToolsResult'))
    assert.ok(Array.isArray(tree.tools))
    assert.ok(tree.tools.length > 0)
  })

  it('ping response has empty result', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'ping', id: 3 })
    assert.equal(res.jsonrpc, '2.0')
    assert.equal(res.id, 3)
    assert.deepEqual(res.result, {})
  })

  it('notifications/initialized returns null (no response)', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(res, null)
  })

  it('unknown method returns JSON-RPC error -32601', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'nonexistent', id: 4 })
    assert.equal(res.jsonrpc, '2.0')
    assert.equal(res.error.code, -32601)
  })

  it('invalid JSON-RPC (missing jsonrpc field) returns error', async () => {
    const core = makeCore()
    const res = await core.handle({ method: 'ping', id: 5 })
    assert.equal(res.jsonrpc, '2.0')
    assert.ok(res.error)
    assert.equal(res.error.code, -32603)
  })

  it('response id matches request id', async () => {
    const core = makeCore()
    const ids = [1, 42, 'abc', 0]
    for (const id of ids) {
      const res = await core.handle({ jsonrpc: '2.0', method: 'ping', id })
      assert.equal(res.id, id)
    }
  })
})
