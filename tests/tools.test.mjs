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
import { createMcpHelpHandlers } from '../src/mcp-help.mjs'
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
    ...createMcpMetaHandlers(getTools),
    ...createMcpHelpHandlers(getTools)
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
  })

  it('advertises category tools with concrete async-style actions', () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const collection = tools.toolList.find(t => t.name === 'mcp.tool.collection')
    const admin = tools.toolList.find(t => t.name === 'mcp.tool.admin')
    const mcp = tools.toolList.find(t => t.name === 'mcp.mcp')
    const help = tools.toolList.find(t => t.name === 'mcp.help')

    assert.deepEqual(collection.inputSchema.properties.action.enum.slice(0, 6), [
      'insert',
      'find',
      'update',
      'remove',
      'insert_with_validation',
      'list'
    ])
    assert.ok(collection.inputSchema.properties.action.enum.includes('get_schema'))
    assert.ok(collection.inputSchema.properties.action.enum.includes('validate_document'))
    assert.ok(!collection.inputSchema.properties.action.enum.includes('node_tree'))
    assert.ok(!collection.inputSchema.properties.action.enum.includes('create_schema'))
    assert.ok(!collection.inputSchema.properties.action.enum.includes('call'))
    assert.ok(!collection.inputSchema.properties.action.enum.includes('describe'))

    assert.deepEqual(admin.inputSchema.properties.action.enum, [
      'aql_query',
      'aql_explain',
      'aql_profile'
    ])
    assert.deepEqual(mcp.inputSchema.properties.action.enum, [
      'search_tools',
      'list_by_category',
      'unload'
    ])
    assert.deepEqual(help.inputSchema.properties.action.enum, ['get', 'list'])
    assert.match(collection.description, /insert - .*mcp\.tool\.collection\(action=insert, payload=\{"collection":"notes","document":\{\}\}\)/)
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
    const driftedSchema = { ...structuredClone(toolsSchema), $defs: { 'mcp.arango': { $ref: 'mcp-arango.schema.json' } } }
    assert.throws(
      () => createTools(driftedSchema, arangoApi, { 'mcp-arango.schema.json': tool }, buildHandlers(arangoApi)),
      /schema action missing \$defs\.actions entry/
    )
  })

  it('mcp.mcp list returns live tool catalog snapshot', async () => {
    const { arangoApi } = buildEnv()
    let toolsRef = null
    const handlers = buildHandlers(arangoApi, () => toolsRef)
    const tools = createTools(toolsSchema, arangoApi, resolverPath, handlers)
    toolsRef = tools
    const result = await tools.callTool('mcp.mcp', {
      action: 'list_by_category',
      payload: { format: 'json' }
    })
    assert.equal(result.isError, false)
    const categoryNames = result.structuredContent.items.map(t => t.name)
    assert.ok(categoryNames.includes('template'))
    assert.ok(categoryNames.includes('collection'))
  })

  it('mcp.mcp search filters tools by keyword', async () => {
    const { arangoApi } = buildEnv()
    let toolsRef = null
    const handlers = buildHandlers(arangoApi, () => toolsRef)
    const tools = createTools(toolsSchema, arangoApi, resolverPath, handlers)
    toolsRef = tools
    const result = await tools.callTool('mcp.mcp', {
      action: 'search_tools',
      payload: { keywords: ['template'], format: 'json' }
    })
    const names = result.structuredContent.items.map(item => item.name)
    assert.ok(names.includes('mcp.tool.template'))
  })

  it('mcp.help returns schema-owned event help for an action', async () => {
    const { arangoApi } = buildEnv()
    let toolsRef = null
    const handlers = buildHandlers(arangoApi, () => toolsRef)
    const tools = createTools(toolsSchema, arangoApi, resolverPath, handlers)
    toolsRef = tools
    const result = await tools.callTool('mcp.help', {
      action: 'get',
      payload: { target: 'mcp.tool.collection', action: 'insert', format: 'json' }
    })
    assert.equal(result.structuredContent.target, 'mcp.tool.collection')
    assert.equal(result.structuredContent.action, 'insert')
    assert.deepEqual(result.structuredContent.event, {
      target: 'mcp.tool.collection',
      action: 'insert',
      payload: { collection: 'notes', document: {} }
    })
    assert.deepEqual(result.structuredContent.payloadSchema.required, ['collection', 'document'])
  })

  it('mcp.help does not list unmigrated actions as normal callable actions', async () => {
    const { arangoApi } = buildEnv()
    let toolsRef = null
    const handlers = buildHandlers(arangoApi, () => toolsRef)
    const tools = createTools(toolsSchema, arangoApi, resolverPath, handlers)
    toolsRef = tools
    const list = await tools.callTool('mcp.help', {
      action: 'list',
      payload: { target: 'mcp.tool.collection', format: 'json' }
    })
    const actions = list.structuredContent.actions.map(item => item.action)
    assert.ok(!actions.includes('create_schema'))
    assert.ok(!actions.includes('node_tree'))

    const help = await tools.callTool('mcp.help', {
      action: 'get',
      payload: { target: 'mcp.tool.collection', action: 'create_schema', format: 'json' }
    })
    assert.equal(help.structuredContent.available, false)
    assert.match(help.structuredContent.reason, /not migrated/)
  })

  it('mcp.tool.collection rejects unmigrated actions at the schema gate', async () => {
    const { arangoApi } = buildEnv()
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.tool.collection', {
        action: 'create_schema',
        payload: { schema_name: 'notes', schema: {} }
      }),
      /not in enum/
    )
  })

  it('mcp.tool.database rejects old target dispatch action', async () => {
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
      /not in enum/
    )
  })

  it('mcp.tool.collection rejects notes insert with invalid runtime schema type root', async () => {
    const { arangoApi } = buildEnv()
    arangoApi.callOperation = async () => {
      throw new Error('invalid runtime schema insert reached Arango dispatch')
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.tool.collection', {
        action: 'insert',
        payload: {
          collection: 'notes',
          document: {
            title: 'Bad runtime type root',
            content: 'This should be rejected before Arango dispatch.',
            tags: ['schema', 'runtime', 'insert'],
            type: ['project', 'runtime-schema'],
            weight: 50,
            created_at: '2026-05-24T00:00:00Z'
          },
          format: 'json'
        }
      }),
      /notes\.type\[0\].*x-first-level/
    )
  })

  it('mcp.tool.collection rejects tags insert with invalid runtime schema', async () => {
    const { arangoApi } = buildEnv()
    arangoApi.callOperation = async () => {
      throw new Error('invalid runtime schema insert reached Arango dispatch')
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.tool.collection', {
        action: 'insert',
        payload: {
          collection: 'tags',
          document: { label: '' },
          format: 'json'
        }
      }),
      /runtime schema validation failed for tags/
    )
  })

  it('mcp.tool.collection get_schema returns runtime collection schema', async () => {
    const { arangoApi } = buildEnv()
    arangoApi.callOperation = async () => {
      throw new Error('get_schema should not dispatch to Arango')
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.tool.collection', {
      action: 'get_schema',
      payload: { schema_name: 'notes', format: 'json' }
    })
    assert.equal(result.structuredContent.collection, 'notes')
    assert.equal(result.structuredContent.schema.type, 'object')
    assert.ok(result.structuredContent.schema.properties.title)
  })

  it('mcp.tool.collection validate_document returns validation result', async () => {
    const { arangoApi } = buildEnv()
    arangoApi.callOperation = async () => {
      throw new Error('validate_document should not dispatch to Arango')
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.tool.collection', {
      action: 'validate_document',
      payload: {
        collection: 'notes',
        document: { title: '', content: '', type: ['project'] },
        format: 'json'
      }
    })
    assert.equal(result.structuredContent.collection, 'notes')
    assert.equal(result.structuredContent.valid, false)
    assert.ok(result.structuredContent.errors.length > 0)
  })

  it('mcp.tool.collection find filter dispatches a bounded AQL cursor', async () => {
    const { arangoApi } = buildEnv()
    let captured = null
    arangoApi.callOperation = async (op, args) => {
      captured = { op, args }
      return { result: [{ _key: 'edge-1' }] }
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.tool.collection', {
      action: 'find',
      payload: {
        collection: 'edges',
        filter: { _from: 'notes/root' },
        limit: 5,
        format: 'json'
      }
    })
    assert.equal(captured.op, 'createAqlQueryCursor')
    assert.match(captured.args.query, /FOR doc IN @@collection FILTER/)
    assert.deepEqual(captured.args.bindVars, {
      '@collection': 'edges',
      limit: 5,
      field0: '_from',
      value0: 'notes/root'
    })
    assert.deepEqual(result.structuredContent, { result: [{ _key: 'edge-1' }] })
  })

  it('mcp.tool.collection validates patch bodies in partial mode', async () => {
    const { arangoApi } = buildEnv()
    let captured = null
    arangoApi.callOperation = async (op, args) => {
      captured = { op, args }
      return { ok: true }
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.tool.collection', {
      action: 'update',
      payload: {
        collection: 'notes',
        key: 'note-1',
        update: { weight: 9 },
        format: 'json'
      }
    })
    assert.deepEqual(captured, {
      op: 'updateDocument',
      args: {
        collection: 'notes',
        key: 'note-1',
        _body: { weight: 9 }
      }
    })
    assert.deepEqual(result.structuredContent, { ok: true })
  })

  it('mcp.tool.collection rejects invalid patch body fields before dispatch', async () => {
    const { arangoApi } = buildEnv()
    arangoApi.callOperation = async () => {
      throw new Error('invalid runtime schema patch reached Arango dispatch')
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    await assert.rejects(
      () => tools.callTool('mcp.tool.collection', {
        action: 'update',
        payload: {
          collection: 'notes',
          key: 'note-1',
          update: { weight: 'bad' },
          format: 'json'
        }
      }),
      /runtime schema validation failed for notes/
    )
  })

  it('rejects custom handler metadata drift when loading tools', () => {
    const { arangoApi } = buildEnv()
    const tool = JSON.parse(readFileSync(new URL('../tools/schema/mcp-mcp.schema.json', import.meta.url), 'utf8'))
    const driftedSchema = { ...structuredClone(toolsSchema), $defs: { 'mcp.mcp': { $ref: 'mcp-mcp.schema.json' } } }
    const handlers = buildHandlers(arangoApi)
    delete handlers['mcpMeta.dispatch']
    assert.throws(
      () => createTools(driftedSchema, arangoApi, { 'mcp-mcp.schema.json': tool }, handlers),
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

  it('mcp.tool.atlas accepts atlas.types mode params through the schema gate', async () => {
    const { arangoApi } = buildEnv()
    arangoApi.callOperation = async (name, args) => {
      assert.equal(name, 'createAqlQueryCursor')
      assert.deepEqual(args.bindVars.root, ['knowledge'])
      assert.equal(args.bindVars.examples, 1)
      return { result: [{ root: 'knowledge', object: 'runtime-schema', aspect: 'rule', subaspect: '-', count: 1, examples: ['Runtime schema note'] }] }
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.tool.atlas', {
      action: 'call',
      payload: {
        target: 'atlas.types',
        params: { mode: 'table', root: ['knowledge'], examples: 1, limit: 5 },
        format: 'json'
      }
    })
    assert.equal(result.isError, false)
    assert.equal(result.structuredContent.profile, 'atlas.types')
    assert.equal(result.structuredContent.mode, 'table')
    assert.deepEqual(result.structuredContent.runtimeRule.firstLevel, ['todo', 'ongoing', 'archived', 'knowledge'])
  })

  it('mcp.tool.atlas renders nested atlas.facets md without object stringification leaks', async () => {
    const { arangoApi } = buildEnv()
    arangoApi.callOperation = async (name) => {
      assert.equal(name, 'createAqlQueryCursor')
      return {
        result: [
          {
            types: [{ root: 'knowledge', object: 'architecture', aspect: 'insight', count: 22 }],
            tags: [{ value: 'architecture', count: 125 }],
            relations: [{ value: 'leads', count: 266 }],
            relationClasses: { structural: ['has', 'is'], history: ['from', 'leads'] }
          }
        ]
      }
    }
    const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi))
    const result = await tools.callTool('mcp.tool.atlas', {
      action: 'call',
      payload: { target: 'atlas.facets', params: { limit: 5 }, format: 'md' }
    })
    const text = result.content[0].text
    assert.equal(result.isError, false)
    assert.doesNotMatch(text, /\[object Object\]/)
    assert.match(text, /\*\*types\*\*/)
    assert.match(text, /\| root \| object \| aspect \| count \|/)
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
