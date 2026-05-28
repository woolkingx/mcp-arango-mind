import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

function createTestCore() {
  return createCore({
    profile: { url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } },
    mcpSchema,
    toolsSchema,
    arangoSchema,
    toolsResolver: join(rootDir, 'tools/schema'),
    templatesDir: join(rootDir, 'config/templates'),
    debug: false
  })
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

describe('Full Function Test', () => {
  it('initialize -> tools/list -> tools/call mcp.arango -> ping', async () => {
    await withMockFetch(
      async () => ({ status: 200, data: { mode: 'readonly' } }),
      async () => {
        const core = createTestCore()

        const init = await core.handle(initializeRequest(1))
        assert.equal(init.result.protocolVersion, '2025-11-25')
        assert.equal(init.result.serverInfo.version, packageJson.version)
        new ObjectTree(init.result, mcpDef('InitializeResult'))

        const list = await core.handle({ jsonrpc: '2.0', method: 'tools/list', id: 2 })
        assert.deepEqual(list.result.tools.map(t => t.name), [
          'mcp.mcp',
          'mcp.help',
          'mcp.arango',
          'mcp.tool.template',
          'mcp.tool.database',
          'mcp.tool.collection',
          'mcp.tool.view',
          'mcp.tool.graph',
          'mcp.tool.admin',
          'mcp.tool.atlas'
        ])
        new ObjectTree(list.result, mcpDef('ListToolsResult'))

        const call = await core.handle({
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 3,
          params: {
            name: 'mcp.arango',
            arguments: { action: 'call', payload: { target: 'getServerAvailability', params: {}, format: 'json' } }
          }
        })
        assert.equal(call.jsonrpc, '2.0')
        assert.equal(call.id, 3)
        assert.deepEqual(call.result.structuredContent, { mode: 'readonly' })
        assert.deepEqual(JSON.parse(call.result.content[0].text), { mode: 'readonly' })
        new ObjectTree(call.result, mcpDef('CallToolResult'))

        const ping = await core.handle({ jsonrpc: '2.0', method: 'ping', id: 4 })
        assert.deepEqual(ping.result, {})
      }
    )
  })

  it('invalid JSON-RPC returns protocol error', async () => {
    const core = createTestCore()
    const res = await core.handle({ method: 'ping', id: 20 })
    assert.equal(res.jsonrpc, '2.0')
    assert.equal(res.error.code, -32600)
  })

  it('null/undefined message returns error without crashing', async () => {
    const core = createTestCore()
    const res1 = await core.handle(null)
    assert.ok(res1.error)
    const res2 = await core.handle(undefined)
    assert.ok(res2.error)
  })

  it('concurrent requests are isolated', async () => {
    await withMockFetch(
      async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return { status: 200, data: { mode: 'readonly' } }
      },
      async () => {
        const core = createTestCore()
        const requests = [30, 31, 32].map(id => core.handle({
          jsonrpc: '2.0',
          method: 'tools/call',
          id,
          params: {
            name: 'mcp.arango',
            arguments: { action: 'call', payload: { target: 'getServerAvailability', params: {} } }
          }
        }))
        const [r1, r2, r3] = await Promise.all(requests)
        assert.equal(r1.id, 30)
        assert.equal(r2.id, 31)
        assert.equal(r3.id, 32)
        assert.ok(r1.result.content)
        assert.ok(r2.result.content)
        assert.ok(r3.result.content)
      }
    )
  })
})
