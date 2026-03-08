// Test 1: MCP protocol conformance — responses match MCP JSON Schema
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ObjectTree } from '../src/lib/schema2object.mjs'
import { createCore } from '../src/core.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const configDir = join(__dirname, '..', 'config')
const mcpSchema = JSON.parse(readFileSync(join(configDir, 'mcp-schema.json'), 'utf8'))
const openapiSpec = JSON.parse(readFileSync(join(configDir, 'arango-openapi.json'), 'utf8'))
const connSchema = JSON.parse(readFileSync(join(configDir, 'arango-connection.json'), 'utf8'))
const profilesConfig = JSON.parse(readFileSync(join(configDir, 'profiles.json'), 'utf8'))
const defs = mcpSchema.definitions

function mcpDef(name) {
  return { $ref: '#/definitions/' + name, definitions: defs }
}

function makeCore() {
  return createCore({
    profile: profilesConfig.profiles[profilesConfig.default],
    mcpSchema, openapiSpec, connSchema, debug: false
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

  it('initialize capabilities include resources', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'initialize', id: 10 })
    assert.ok(res.result.capabilities.resources)
  })

  it('resources/list response matches ListResourcesResult schema', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'resources/list', id: 11 })
    assert.equal(res.jsonrpc, '2.0')
    assert.ok(res.result)
    const tree = new ObjectTree(res.result, mcpDef('ListResourcesResult'))
    assert.ok(Array.isArray(tree.resources))
    assert.ok(tree.resources.length > 200)
  })

  it('resources/read categories returns valid content', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'resources/read', id: 12, params: { uri: 'tool://categories' } })
    assert.equal(res.jsonrpc, '2.0')
    assert.ok(res.result.contents)
    assert.equal(res.result.contents[0].mimeType, 'application/json')
    const cats = JSON.parse(res.result.contents[0].text)
    assert.ok(Object.keys(cats).length > 10, 'Should have 10+ categories')
  })

  it('resources/read tool help returns structured data', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'resources/read', id: 13, params: { uri: 'tool://help/createAqlQueryCursor' } })
    assert.ok(res.result.contents)
    const help = JSON.parse(res.result.contents[0].text)
    assert.equal(help.name, 'createAqlQueryCursor')
    assert.ok(help.tag)
    assert.ok(help.http.method)
    assert.ok(help.http.path)
    assert.ok(help.parameters)
  })

  it('resources/read unknown tool returns error', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'resources/read', id: 14, params: { uri: 'tool://help/nonexistent' } })
    assert.ok(res.error)
  })

  it('tools/list returns category tools with tool count', async () => {
    const core = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'tools/list', id: 15 })
    assert.ok(res.result.tools.length >= 20 && res.result.tools.length <= 30,
      `Expected 20-30 categories, got ${res.result.tools.length}`)
    for (const tool of res.result.tools) {
      assert.match(tool.description, /^\d+ tools:/, `Category ${tool.name} should list tool count`)
    }
  })
})
