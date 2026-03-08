// Test 3: MCP ↔ OpenAPI message bridge — payload flows correctly through bus
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBus } from '../src/bus.mjs'
import { createConnection } from '../src/connection.mjs'
import { createDispatch } from '../src/dispatch.mjs'
import { createProtocol } from '../src/protocol.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const configDir = join(__dirname, '..', 'config')
const mcpSchema = JSON.parse(readFileSync(join(configDir, 'mcp-schema.json'), 'utf8'))
const openapiSpec = JSON.parse(readFileSync(join(configDir, 'arango-openapi.json'), 'utf8'))
const connSchema = JSON.parse(readFileSync(join(configDir, 'arango-connection.json'), 'utf8'))

function setup(mockRequest, localHandlers = {}) {
  const bus = createBus()
  const conn = createConnection({
    url: 'http://localhost:8529', database: '_system',
    auth: { username: 'root', password: '' }
  })
  // Replace conn.request with mock
  conn.request = mockRequest
  // Capture log messages
  const logs = []
  bus.handle('log', (msg) => logs.push(msg))
  const d = createDispatch(bus, conn, openapiSpec, connSchema, localHandlers)
  createProtocol(bus, mcpSchema, {
    toolList: d.getToolList(),
    dispatchCategory: d.dispatchCategory,
    resourceList: d.getResourceList(),
    getCategories: d.getCategories,
    getToolHelp: d.getToolHelp
  })
  return { bus, logs, conn }
}

describe('MCP ↔ OpenAPI Message Bridge', () => {

  it('tools/call dispatches correct HTTP method and path', async () => {
    let captured = null
    const { bus } = setup(async (method, path, opts) => {
      captured = { method, path, body: opts?.body }
      return { status: 200, data: { result: [] } }
    })

    const validated = await bus.send('validate', {
      jsonrpc: '2.0', method: 'tools/call', id: 1,
      params: { name: 'listCollections', arguments: {} }
    })
    const res = await bus.send('route', validated)

    assert.ok(captured, 'pool.fetch should have been called')
    assert.equal(captured.method, 'GET')
    assert.ok(captured.path.includes('collection'), `Path should contain "collection": ${captured.path}`)
  })

  it('path params are substituted into URL', async () => {
    let captured = null
    const { bus } = setup(async (method, path, opts) => {
      captured = { method, path }
      return { status: 200, data: {} }
    })

    await bus.send('validate', {
      jsonrpc: '2.0', method: 'tools/call', id: 2,
      params: { name: 'getCollection', arguments: { 'collection-name': 'myCol' } }
    }).then(v => bus.send('route', v))

    assert.ok(captured)
    assert.ok(captured.path.includes('myCol'), `Path should contain "myCol": ${captured.path}`)
    assert.ok(!captured.path.includes('{'), `Path should not have unresolved template: ${captured.path}`)
  })

  it('request body is forwarded to pool.fetch', async () => {
    let captured = null
    const { bus } = setup(async (method, path, opts) => {
      captured = { method, path, body: opts?.body }
      return { status: 201, data: { id: '123' } }
    })

    await bus.send('validate', {
      jsonrpc: '2.0', method: 'tools/call', id: 3,
      params: { name: 'createAqlQueryCursor', arguments: { query: 'RETURN 1' } }
    }).then(v => bus.send('route', v))

    assert.ok(captured)
    assert.equal(captured.method, 'POST')
    assert.ok(captured.body, 'Body should be present')
    assert.ok(captured.body.query, 'Body should contain query')
  })

  it('dispatch error returns isError CallToolResult, not JSON-RPC error', async () => {
    const { bus } = setup(async () => {
      throw new Error('ArangoDB connection refused')
    })

    const validated = await bus.send('validate', {
      jsonrpc: '2.0', method: 'tools/call', id: 4,
      params: { name: 'listCollections', arguments: {} }
    })
    const res = await bus.send('route', validated)

    assert.equal(res.jsonrpc, '2.0')
    assert.ok(res.result, 'Should be a result, not error')
    assert.equal(res.result.isError, true)
    assert.ok(res.result.content[0].text.includes('connection refused'))
  })

  it('unknown tool returns isError result', async () => {
    const { bus } = setup(async () => ({ status: 200, data: {} }))

    const validated = await bus.send('validate', {
      jsonrpc: '2.0', method: 'tools/call', id: 5,
      params: { name: 'nonexistent_tool', arguments: {} }
    })
    const res = await bus.send('route', validated)

    assert.ok(res.result.isError)
  })

  it('bus logs track message status for every send', async () => {
    const { bus, logs } = setup(async () => ({ status: 200, data: {} }))

    await bus.send('validate', {
      jsonrpc: '2.0', method: 'ping', id: 6
    })

    // logs should have at least one entry with status
    assert.ok(logs.length > 0, 'Should have log entries')
    for (const log of logs) {
      assert.ok(log.event, 'Log should have event')
      assert.ok(log.status === 'completed' || log.status === 'failed',
        `Log status should be completed or failed: ${log.status}`)
      assert.ok(typeof log.duration === 'number', 'Log should have duration')
    }
  })

  it('Connection category appears in tools/list', async () => {
    const { bus } = setup(async () => ({ status: 200, data: {} }))
    const validated = await bus.send('validate', { jsonrpc: '2.0', method: 'tools/list', id: 10 })
    const res = await bus.send('route', validated)
    const tools = res.result.tools
    const conn = tools.find(t => t.name === 'Connection')
    assert.ok(conn, 'Connection category should be in tools/list')
    assert.ok(conn.inputSchema.properties.action.enum.includes('getConfig'))
    assert.ok(conn.inputSchema.properties.action.enum.includes('setDatabase'))
    assert.ok(conn.inputSchema.properties.action.enum.includes('setAuth'))
  })

  it('Connection getConfig returns database and url', async () => {
    const localHandlers = {
      getConfig: () => ({ database: '_system', url: 'http://localhost:8529' })
    }
    const { bus } = setup(async () => ({ status: 200, data: {} }), localHandlers)
    const validated = await bus.send('validate', {
      jsonrpc: '2.0', method: 'tools/call', id: 11,
      params: { name: 'Connection', arguments: { action: 'getConfig' } }
    })
    const res = await bus.send('route', validated)
    assert.ok(!res.result.isError, 'Should not be error')
    const data = JSON.parse(res.result.content[0].text)
    assert.equal(data.database, '_system')
    assert.ok(data.url)
  })

  it('Connection setDatabase missing required param returns error', async () => {
    const localHandlers = {
      setDatabase: (args) => { throw new Error('database parameter required') }
    }
    const { bus } = setup(async () => ({ status: 200, data: {} }), localHandlers)
    const validated = await bus.send('validate', {
      jsonrpc: '2.0', method: 'tools/call', id: 12,
      params: { name: 'Connection', arguments: { action: 'setDatabase' } }
    })
    const res = await bus.send('route', validated)
    assert.ok(res.result.isError, 'Missing required param should return isError')
  })
})
