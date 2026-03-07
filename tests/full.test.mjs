// Test 4: Full function test — core.handle() end-to-end with mock HTTP
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
const defs = mcpSchema.definitions

function mcpDef(name) {
  return { $ref: '#/definitions/' + name, definitions: defs }
}

// Mock globalThis.fetch to intercept all HTTP calls
function withMockFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const result = await handler(url, opts)
    return {
      status: result.status || 200,
      json: async () => result.data,
      ok: (result.status || 200) < 400
    }
  }
  return fn().finally(() => { globalThis.fetch = original })
}

describe('Full Function Test', () => {

  it('initialize → tools/list → tools/call full lifecycle', async () => {
    await withMockFetch(
      async (url) => ({ status: 200, data: { result: [{ name: 'test' }] } }),
      async () => {
        const core = createCore({
          profile: { url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } },
          mcpSchema, openapiSpec, debug: false
        })

        // Step 1: initialize
        const init = await core.handle({ jsonrpc: '2.0', method: 'initialize', id: 1 })
        assert.equal(init.result.protocolVersion, '2025-03-26')
        new ObjectTree(init.result, mcpDef('InitializeResult'))

        // Step 2: tools/list
        const list = await core.handle({ jsonrpc: '2.0', method: 'tools/list', id: 2 })
        assert.ok(list.result.tools.length > 200)
        new ObjectTree(list.result, mcpDef('ListToolsResult'))

        // Step 3: tools/call
        const call = await core.handle({
          jsonrpc: '2.0', method: 'tools/call', id: 3,
          params: { name: 'listCollections', arguments: {} }
        })
        assert.equal(call.jsonrpc, '2.0')
        assert.equal(call.id, 3)
        assert.ok(call.result.content)
        assert.equal(call.result.content[0].type, 'text')
        // Parse the text content — should be our mock data
        const data = JSON.parse(call.result.content[0].text)
        assert.deepEqual(data, { result: [{ name: 'test' }] })
      }
    )
  })

  it('tools/call with ArangoDB-like response', async () => {
    await withMockFetch(
      async (url, opts) => {
        if (url.includes('cursor')) {
          return { status: 201, data: { result: [1, 2, 3], hasMore: false, id: '12345' } }
        }
        return { status: 200, data: {} }
      },
      async () => {
        const core = createCore({
          profile: { url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } },
          mcpSchema, openapiSpec, debug: false
        })

        const res = await core.handle({
          jsonrpc: '2.0', method: 'tools/call', id: 10,
          params: { name: 'createAqlQueryCursor', arguments: { query: 'FOR i IN 1..3 RETURN i' } }
        })

        assert.ok(res.result.content)
        const data = JSON.parse(res.result.content[0].text)
        assert.deepEqual(data.result, [1, 2, 3])
      }
    )
  })

  it('handles HTTP errors gracefully', async () => {
    await withMockFetch(
      async () => ({ status: 404, data: { error: true, errorMessage: 'collection not found' } }),
      async () => {
        const core = createCore({
          profile: { url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } },
          mcpSchema, openapiSpec, debug: false
        })

        const res = await core.handle({
          jsonrpc: '2.0', method: 'tools/call', id: 11,
          params: { name: 'getCollection', arguments: { 'collection-name': 'nonexistent' } }
        })

        // Should still be a result (not JSON-RPC error) — tool errors are results
        assert.ok(res.result)
        const data = JSON.parse(res.result.content[0].text)
        // HTTP 404 is still returned as data — dispatch returns { status, data }
        assert.ok(data)
      }
    )
  })

  it('invalid JSON-RPC returns protocol error', async () => {
    const core = createCore({
      profile: { url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } },
      mcpSchema, openapiSpec, debug: false
    })

    const res = await core.handle({ method: 'ping', id: 20 })
    assert.equal(res.jsonrpc, '2.0')
    assert.ok(res.error)
    assert.equal(res.error.code, -32603)
  })

  it('null/undefined message returns error without crashing', async () => {
    const core = createCore({
      profile: { url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } },
      mcpSchema, openapiSpec, debug: false
    })

    const res1 = await core.handle(null)
    assert.ok(res1.error)

    const res2 = await core.handle(undefined)
    assert.ok(res2.error)
  })

  it('concurrent requests are isolated', async () => {
    let callCount = 0
    await withMockFetch(
      async (url) => {
        callCount++
        await new Promise(r => setTimeout(r, 10))
        return { status: 200, data: { call: callCount } }
      },
      async () => {
        const core = createCore({
          profile: { url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } },
          mcpSchema, openapiSpec, debug: false
        })

        const [r1, r2, r3] = await Promise.all([
          core.handle({ jsonrpc: '2.0', method: 'tools/call', id: 30, params: { name: 'listCollections', arguments: {} } }),
          core.handle({ jsonrpc: '2.0', method: 'tools/call', id: 31, params: { name: 'listCollections', arguments: {} } }),
          core.handle({ jsonrpc: '2.0', method: 'tools/call', id: 32, params: { name: 'listCollections', arguments: {} } }),
        ])

        // Each response should have its own id
        assert.equal(r1.id, 30)
        assert.equal(r2.id, 31)
        assert.equal(r3.id, 32)
        // All should succeed
        assert.ok(r1.result.content)
        assert.ok(r2.result.content)
        assert.ok(r3.result.content)
      }
    )
  })
})
