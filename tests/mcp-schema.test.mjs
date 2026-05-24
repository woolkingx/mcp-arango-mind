import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { ObjectTree } from '../src/lib/schema2object.mjs'
import { createCore } from '../src/core.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const mcpSchema = JSON.parse(readFileSync(join(rootDir, 'mcp/schema/mcp.schema.json'), 'utf8'))
const toolsSchema = JSON.parse(readFileSync(join(rootDir, 'tools/schema/tools.schema.json'), 'utf8'))
const arangoSchema = JSON.parse(readFileSync(join(rootDir, 'arango/schema/arango.openapi.schema.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
const defs = mcpSchema.$defs

function mcpDef(name) {
  return { $ref: '#/$defs/' + name, $defs: defs }
}

function initializeRequest(id = 1) {
  return {
    jsonrpc: '2.0',
    method: 'initialize',
    id,
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'mcp-arango-mind-test', version: '0.0.0' }
    }
  }
}

function makeCore(mockRequest = async () => ({ status: 200, data: { mode: 'readonly' } })) {
  const core = createCore({
    profile: { url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } },
    mcpSchema,
    toolsSchema,
    arangoSchema,
    toolsResolver: join(rootDir, 'tools/schema'),
    templatesDir: join(rootDir, 'config/templates'),
    debug: false
  })
  return { core, mockRequest }
}

function withMockFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const result = await handler(url, opts)
    const status = result.status || 200
    return {
      status,
      json: async () => result.data,
      text: async () => JSON.stringify(result.data),
      ok: status < 400,
      headers: new Headers({ 'content-type': 'application/json' })
    }
  }
  return fn().finally(() => { globalThis.fetch = original })
}

describe('MCP Schema Conformance', () => {
  it('initialize response matches InitializeResult schema', async () => {
    const { core } = makeCore()
    const res = await core.handle(initializeRequest(1))
    assert.equal(res.jsonrpc, '2.0')
    assert.equal(res.id, 1)
    const tree = new ObjectTree(res.result, mcpDef('InitializeResult'))
    assert.equal(tree.protocolVersion, '2025-11-25')
    assert.equal(tree.serverInfo.version, packageJson.version)
    assert.ok(tree.serverInfo)
    assert.ok(tree.capabilities)
  })

  it('tools/list response matches ListToolsResult schema', async () => {
    const { core } = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'tools/list', id: 2 })
    assert.equal(res.jsonrpc, '2.0')
    const tree = new ObjectTree(res.result, mcpDef('ListToolsResult'))
    assert.deepEqual(tree.tools.map(t => t.name), [
      'mcp.mcp',
      'mcp.arango',
      'mcp.tool.template',
      'mcp.tool.database',
      'mcp.tool.collection',
      'mcp.tool.view',
      'mcp.tool.graph',
      'mcp.tool.admin',
      'mcp.tool.atlas'
    ])
  })

  it('tools/call response matches CallToolResult schema', async () => {
    await withMockFetch(
      async () => ({ status: 200, data: { mode: 'readonly' } }),
      async () => {
        const { core } = makeCore()
        const res = await core.handle({
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 3,
          params: {
            name: 'mcp.arango',
            arguments: { action: 'call', payload: { target: 'getServerAvailability', params: {}, format: 'json' } }
          }
        })
        assert.equal(res.jsonrpc, '2.0')
        const tree = new ObjectTree(res.result, mcpDef('CallToolResult'))
        assert.equal(tree.isError, false)
        assert.deepEqual(res.result.structuredContent, { mode: 'readonly' })
      }
    )
  })

  it('ping response has empty result', async () => {
    const { core } = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'ping', id: 4 })
    assert.equal(res.jsonrpc, '2.0')
    assert.equal(res.id, 4)
    assert.deepEqual(res.result, {})
  })

  it('notifications/initialized returns null', async () => {
    const { core } = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(res, null)
  })

  it('unknown method returns JSON-RPC error -32601', async () => {
    const { core } = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'nonexistent', id: 5 })
    assert.equal(res.error.code, -32601)
  })

  it('invalid JSON-RPC returns an invalid request error response', async () => {
    const { core } = makeCore()
    const res = await core.handle({ method: 'ping', id: 6 })
    assert.equal(res.jsonrpc, '2.0')
    assert.equal(res.error.code, -32600)
  })

  it('initialize request must match the MCP request schema', async () => {
    const { core } = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'initialize', id: 9 })
    assert.equal(res.error.code, -32600)
  })

  it('request methods require a valid request id', async () => {
    const { core } = makeCore()
    const missing = await core.handle({ jsonrpc: '2.0', method: 'ping' })
    assert.equal(missing.id, null)
    assert.equal(missing.error.code, -32600)
    const bad = await core.handle({ jsonrpc: '2.0', method: 'ping', id: 1.2 })
    assert.equal(bad.id, null)
    assert.equal(bad.error.code, -32600)
  })

  it('resources/list is empty until a resource schema exists', async () => {
    const { core } = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'resources/list', id: 7 })
    assert.deepEqual(res.result.resources, [])
  })

  it('resources/read unknown resource returns error', async () => {
    const { core } = makeCore()
    const res = await core.handle({ jsonrpc: '2.0', method: 'resources/read', id: 8, params: { uri: 'resource://missing' } })
    assert.equal(res.error.code, -32602)
  })
})
