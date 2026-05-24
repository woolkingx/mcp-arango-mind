import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBus } from '../src/bus.mjs'
import { createConnection } from '../src/connection.mjs'
import { createMcp } from '../src/mcp.mjs'
import { createArangoApi } from '../src/arango-api.mjs'
import { createTools } from '../src/tools.mjs'
import { createProtocol } from '../src/protocol.mjs'
import { createArangoSurfaceHandlers } from '../src/arango-surface.mjs'
import { createTemplateOwnerHandlers } from '../src/template-owner.mjs'
import { createCategoryOwnerHandlers } from '../src/tool-category-owner.mjs'
import { createMcpMetaHandlers } from '../src/mcp-meta.mjs'
import { createAtlasOwnerHandlers } from '../src/atlas-owner.mjs'

const CATEGORY_DEFS = [
  { name: 'database',   tags: ['Databases'] },
  { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] },
  { name: 'view',       tags: ['Views', 'Analyzers'] },
  { name: 'graph',      tags: ['Graphs'] },
  { name: 'admin',      tags: ['Administration', 'Queries', 'Monitoring', 'Tasks'] }
]

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const mcpSchema = JSON.parse(readFileSync(join(rootDir, 'mcp/schema/mcp.schema.json'), 'utf8'))
const toolsSchema = JSON.parse(readFileSync(join(rootDir, 'tools/schema/tools.schema.json'), 'utf8'))
const arangoSchema = JSON.parse(readFileSync(join(rootDir, 'arango/schema/arango.openapi.schema.json'), 'utf8'))

function setup(mockRequest) {
  const bus = createBus()
  const conn = createConnection({
    url: 'http://localhost:8529',
    database: '_system',
    auth: { username: 'root', password: '' }
  })
  conn.request = mockRequest
  const logs = []
  bus.handle('log', (msg) => logs.push(msg))
  const mcp = createMcp(mcpSchema)
  const arangoApi = createArangoApi(bus, conn, arangoSchema)
  let toolsRef = null
  const customHandlers = {
    ...createArangoSurfaceHandlers(arangoApi),
    ...createTemplateOwnerHandlers(arangoApi, { templatesDir: join(rootDir, 'config/templates') }),
    ...createAtlasOwnerHandlers(arangoApi),
    ...createMcpMetaHandlers(() => toolsRef)
  }
  for (const def of CATEGORY_DEFS) {
    Object.assign(customHandlers, createCategoryOwnerHandlers(arangoApi, def))
  }
  const tools = createTools(toolsSchema, arangoApi, join(rootDir, 'tools/schema'), customHandlers)
  toolsRef = tools
  createProtocol(bus, mcp, tools)
  return { bus, logs, conn }
}

describe('MCP -> tools -> Arango message bridge', () => {
  it('tools/list returns the active master tools', async () => {
    const { bus } = setup(async () => ({ status: 200, data: {} }))
    const validated = await bus.send('validate', { jsonrpc: '2.0', method: 'tools/list', id: 1 })
    const res = await bus.send('route', validated)
    assert.deepEqual(res.result.tools.map(t => t.name), [
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

  it('tools/call mcp.arango call dispatches GET /_admin/server/availability', async () => {
    let captured = null
    const { bus } = setup(async (method, path, opts) => {
      captured = { method, path, opts }
      return { status: 200, data: { mode: 'readonly' } }
    })

    const validated = await bus.send('validate', {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 2,
      params: {
        name: 'mcp.arango',
        arguments: { action: 'call', payload: { target: 'getServerAvailability', params: {}, format: 'json' } }
      }
    })
    const res = await bus.send('route', validated)
    assert.equal(captured.method, 'GET')
    assert.equal(captured.path, '/_admin/server/availability')
    assert.deepEqual(res.result.structuredContent, { mode: 'readonly' })
  })

  it('unknown tool returns JSON-RPC error -32602', async () => {
    const { bus } = setup(async () => ({ status: 200, data: {} }))
    const validated = await bus.send('validate', {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 3,
      params: { name: 'not_real', arguments: {} }
    })
    const res = await bus.send('route', validated)
    assert.equal(res.error.code, -32602)
  })

  it('tool execution error returns CallToolResult with isError true', async () => {
    const { bus } = setup(async () => {
      throw new Error('ArangoDB connection refused')
    })
    const validated = await bus.send('validate', {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 4,
      params: {
        name: 'mcp.arango',
        arguments: { action: 'call', payload: { target: 'getServerAvailability', params: {} } }
      }
    })
    const res = await bus.send('route', validated)
    assert.ok(res.result)
    assert.equal(res.result.isError, true)
    assert.ok(res.result.content[0].text.includes('connection refused'))
  })

  it('tools/call mcp.mcp list categories surfaces the master category map', async () => {
    const { bus } = setup(async () => ({ status: 200, data: {} }))
    const validated = await bus.send('validate', {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 5,
      params: {
        name: 'mcp.mcp',
        arguments: { action: 'list', payload: { target: 'categories', format: 'json' } }
      }
    })
    const res = await bus.send('route', validated)
    const items = res.result.structuredContent.items
    const names = items.map(c => c.name).sort()
    assert.deepEqual(names, ['database', 'graph', 'mcp', 'view', 'collection', 'admin', 'template', 'atlas'].sort())
  })

  it('bus logs track message status for every send', async () => {
    const { bus, logs } = setup(async () => ({ status: 200, data: {} }))
    await bus.send('validate', { jsonrpc: '2.0', method: 'ping', id: 5 })
    assert.ok(logs.length > 0)
    for (const log of logs) {
      assert.ok(log.event)
      assert.ok(log.status === 'completed' || log.status === 'failed')
      assert.ok(typeof log.duration === 'number')
    }
  })
})
