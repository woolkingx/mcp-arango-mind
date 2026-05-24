import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createBus } from '../src/bus.mjs'
import { createConnection } from '../src/connection.mjs'
import { createArangoApi } from '../src/arango-api.mjs'
import { createTools } from '../src/tools.mjs'
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

const toolsSchema = JSON.parse(readFileSync(new URL('../tools/schema/tools.schema.json', import.meta.url), 'utf8'))
const openapiSpec = JSON.parse(readFileSync(new URL('../arango/schema/arango.openapi.schema.json', import.meta.url), 'utf8'))

const resolverPath = new URL('../tools/schema/', import.meta.url).pathname

const templatesDir = new URL('../config/templates/', import.meta.url).pathname

function buildHandlers(arangoApi, getTools = () => null) {
  const handlers = {
    ...createArangoSurfaceHandlers(arangoApi),
    ...createTemplateOwnerHandlers(arangoApi, { templatesDir }),
    ...createAtlasOwnerHandlers(arangoApi),
    ...createMcpMetaHandlers(getTools)
  }
  for (const def of CATEGORY_DEFS) {
    Object.assign(handlers, createCategoryOwnerHandlers(arangoApi, def))
  }
  return handlers
}

function buildEnv() {
  const bus = createBus()
  const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
  const arangoApi = createArangoApi(bus, conn, openapiSpec)
  return { bus, conn, arangoApi }
}

describe('tools schema', () => {
  it('activates tools through tools.schema.json reachability', () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    assert.deepEqual(tools.toolList.map(t => t.name), [
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

  it('mcp.arango call dispatches getServerAvailability', async () => {
    const { conn, arangoApi } = buildEnv()
    let captured = null
    conn.request = async (method, path, opts) => {
      captured = { method, path, opts }
      return { status: 200, data: { mode: 'readonly' } }
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.arango', {
      action: 'call',
      payload: { target: 'getServerAvailability', params: {}, format: 'json' }
    })
    assert.equal(captured.method, 'GET')
    assert.equal(captured.path, '/_admin/server/availability')
    assert.deepEqual(result.structuredContent, { mode: 'readonly' })
    assert.equal(result.isError, false)
  })

  it('mcp.arango call forwards only params to the OpenAPI operation', async () => {
    const { arangoApi } = buildEnv()
    let operationArgs = null
    arangoApi.callOperation = async (_name, args) => {
      operationArgs = args
      return { mode: 'readonly' }
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await tools.callTool('mcp.arango', {
      action: 'call',
      payload: { target: 'getServerAvailability', params: {}, format: 'json' }
    })
    assert.deepEqual(operationArgs, {})
  })

  it('mcp.arango describe returns operation contract', async () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.arango', {
      action: 'describe',
      payload: { target: 'getServerAvailability', format: 'json' }
    })
    assert.equal(result.structuredContent.operationId, 'getServerAvailability')
    assert.equal(result.structuredContent.method, 'GET')
    assert.equal(result.structuredContent.path, '/_admin/server/availability')
  })

  it('mcp.arango search returns matching operations', async () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.arango', {
      action: 'search',
      payload: { keywords: ['availability'], format: 'json' }
    })
    assert.ok(result.structuredContent.operations.some(op => op.operationId === 'getServerAvailability'))
  })

  it('mcp.arango search accepts query string entrypoint', async () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.arango', {
      action: 'search',
      payload: { query: 'server availability', format: 'json' }
    })
    assert.ok(result.structuredContent.operations.some(op => op.operationId === 'getServerAvailability'))
  })

  it('mcp.arango exec dispatches an OpenAPI operation', async () => {
    const { arangoApi } = buildEnv()
    let operationArgs = null
    arangoApi.callOperation = async (name, args) => {
      assert.equal(name, 'getServerAvailability')
      operationArgs = args
      return { mode: 'readonly' }
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.arango', {
      action: 'exec',
      payload: { target: 'getServerAvailability', params: {}, format: 'json' }
    })
    assert.deepEqual(operationArgs, {})
    assert.deepEqual(result.structuredContent, { mode: 'readonly' })
  })

  it('rejects mcp.arango call without target at the schema gate', async () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.arango', { action: 'call', payload: { params: {} } }),
      /missing required "target"/
    )
  })

  it('rejects mcp.arango invalid format at the schema gate', async () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.arango', {
        action: 'call',
        payload: { target: 'getServerAvailability', format: 'xml' }
      }),
      /not in enum/
    )
  })

  it('rejects missing payload in the command envelope', async () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.arango', { action: 'call' }),
      /missing required "payload"/
    )
  })

  it('rejects non-object payloads in the command envelope', async () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.arango', { action: 'call', payload: 'raw' }),
      /expected object/
    )
  })

  it('rejects unknown actions at the command schema gate', async () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.arango', { action: 'notReal', payload: {} }),
      /not in enum/
    )
  })

  it('rejects schema action metadata drift when loading tools', () => {
    const { arangoApi } = buildEnv()
    const tool = JSON.parse(readFileSync(new URL('../tools/schema/mcp-arango.schema.json', import.meta.url), 'utf8'))
    tool.properties.action.enum = ['search', 'exec', 'describe', 'list', 'call', 'missingAction']
    const driftedSchema = { ...structuredClone(toolsSchema), 'x-tools': [{ $ref: 'mcp-arango.schema.json' }] }
    assert.throws(
      () => createTools(driftedSchema, arangoApi, { 'mcp-arango.schema.json': tool }, buildHandlers(arangoApi)),
      /schema action missing x-tool.actions metadata/
    )
  })

  it('mcp.mcp list returns live tool catalog snapshot', async () => {
    const { arangoApi } = buildEnv()
    let toolsRef = null
    const handlers = buildHandlers(arangoApi, () => toolsRef)
    const tools = createTools(toolsSchema, arangoApi, resolverPath, handlers)
    toolsRef = tools
    const result = await tools.callTool('mcp.mcp', {
      action: 'list',
      payload: { target: 'tools', format: 'json' }
    })
    assert.equal(result.isError, false)
    const names = result.structuredContent.items.map(t => t.name)
    assert.ok(names.includes('mcp.tool.template'))
    assert.ok(names.includes('mcp.arango'))
  })

  it('mcp.mcp search filters tools by keyword', async () => {
    const { arangoApi } = buildEnv()
    let toolsRef = null
    const handlers = buildHandlers(arangoApi, () => toolsRef)
    const tools = createTools(toolsSchema, arangoApi, resolverPath, handlers)
    toolsRef = tools
    const result = await tools.callTool('mcp.mcp', {
      action: 'search',
      payload: { keywords: ['template'], format: 'json' }
    })
    assert.equal(result.structuredContent.total, 1)
    assert.equal(result.structuredContent.items[0].name, 'mcp.tool.template')
  })

  it('mcp.tool.database call enforces the Databases whitelist', async () => {
    const { arangoApi } = buildEnv()
    let toolsRef = null
    const handlers = buildHandlers(arangoApi, () => toolsRef)
    const tools = createTools(toolsSchema, arangoApi, resolverPath, handlers)
    toolsRef = tools
    await assert.rejects(
      () => tools.callTool('mcp.tool.database', {
        action: 'call',
        payload: { target: 'getServerAvailability', params: {} }
      }),
      /outside database category/
    )
  })

  it('rejects custom handler metadata drift when loading tools', () => {
    const { arangoApi } = buildEnv()
    const tool = JSON.parse(readFileSync(new URL('../tools/schema/mcp-mcp.schema.json', import.meta.url), 'utf8'))
    tool['x-tool'].actions.list.handler = 'mcpMeta.missing'
    const driftedSchema = { ...structuredClone(toolsSchema), 'x-tools': [{ $ref: 'mcp-mcp.schema.json' }] }
    assert.throws(
      () => createTools(driftedSchema, arangoApi, { 'mcp-mcp.schema.json': tool }, buildHandlers(arangoApi)),
      /tool action references unknown handler/
    )
  })

  it('mcp.tool.atlas call dispatches atlas profile AQL', async () => {
    const { arangoApi } = buildEnv()
    arangoApi.callOperation = async (name, args) => {
      assert.equal(name, 'createAqlQueryCursor')
      assert.equal(args.bindVars.root, 'notes/root')
      return { result: [{ root: { _id: 'notes/root' }, tree: [], sources: [] }] }
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.tool.atlas', {
      action: 'call',
      payload: { target: 'atlas.index', params: { root: 'notes/root' }, format: 'json' }
    })
    assert.equal(result.isError, false)
    assert.equal(result.structuredContent.profile, 'atlas.index')
    assert.equal(result.structuredContent.count, 1)
  })

  it('mcp.tool.atlas rejects collection override at the schema gate', async () => {
    const { arangoApi } = buildEnv()
    arangoApi.callOperation = async () => {
      throw new Error('atlas override reached dispatch')
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.tool.atlas', {
        action: 'call',
        payload: { target: 'atlas.facets', params: { nodeCollection: '_users' }, format: 'json' }
      }),
      /additional property "nodeCollection" not allowed/
    )
  })
})
