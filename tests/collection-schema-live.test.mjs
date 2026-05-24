import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createBus } from '../src/bus.mjs'
import { createConnection } from '../src/connection.mjs'
import { loadEnv, profileFromEnv } from '../src/env.mjs'
import { createArangoApi } from '../src/arango-api.mjs'
import { createTools } from '../src/tools.mjs'
import { createArangoSurfaceHandlers } from '../src/arango-surface.mjs'
import { createTemplateOwnerHandlers } from '../src/template-owner.mjs'
import { createCategoryOwnerHandlers } from '../src/tool-category-owner.mjs'
import { createMcpMetaHandlers } from '../src/mcp-meta.mjs'
import { createAtlasOwnerHandlers } from '../src/atlas-owner.mjs'

const CATEGORY_DEFS = [
  { name: 'database', tags: ['Databases'] },
  { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] },
  { name: 'view', tags: ['Views', 'Analyzers'] },
  { name: 'graph', tags: ['Graphs'] },
  { name: 'admin', tags: ['Administration', 'Queries', 'Monitoring', 'Tasks'] }
]

const toolsSchema = JSON.parse(readFileSync(new URL('../tools/schema/tools.schema.json', import.meta.url), 'utf8'))
const openapiSpec = JSON.parse(readFileSync(new URL('../arango/schema/arango.openapi.schema.json', import.meta.url), 'utf8'))
const resolverPath = new URL('../tools/schema/', import.meta.url).pathname
const templatesDir = new URL('../config/templates/', import.meta.url).pathname

loadEnv()
const env = profileFromEnv()
const SKIP = !env.url
if (SKIP) console.log('# SKIP: No ARANGO_URL in .env - collection schema live tests skipped')

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

function buildTools() {
  const conn = createConnection(env)
  const arangoApi = createArangoApi(createBus(), conn, openapiSpec)
  let toolsRef = null
  const tools = createTools(toolsSchema, arangoApi, resolverPath, buildHandlers(arangoApi, () => toolsRef))
  toolsRef = tools
  return { conn, tools }
}

async function callCollection(tools, target, params) {
  return await tools.callTool('mcp.tool.collection', {
    action: 'call',
    payload: { target, params, format: 'json' }
  })
}

function assertSchemaError(result) {
  assert.equal(result.structuredContent.error, true)
  assert.equal(result.structuredContent.code, 400)
  assert.equal(result.structuredContent.errorNum, 1620)
  assert.match(result.structuredContent.errorMessage, /crud schema violation|schema|validation/i)
}

describe('mcp.tool.collection: live collection schema validation', { skip: SKIP }, () => {
  it('enforces CRUD document fields and data correctness through ArangoDB schema validation', async () => {
    const { conn, tools } = buildTools()
    const name = `test_schema_${Date.now()}`
    try {
      await callCollection(tools, 'deleteCollection', { 'collection-name': name })

      const create = await callCollection(tools, 'createCollection', {
        name,
        schema: {
          level: 'strict',
          message: 'crud schema violation',
          rule: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'count'],
            properties: {
              kind: { type: 'string', enum: ['note'] },
              count: { type: 'integer', minimum: 1 },
              status: { type: 'string', enum: ['draft', 'done'] }
            }
          }
        }
      })
      assert.equal(create.structuredContent.error, false)

      const valid = await callCollection(tools, 'createDocument', {
        collection: name,
        returnNew: true,
        _body: { kind: 'note', count: 1, status: 'draft' }
      })
      assert.notEqual(valid.structuredContent.error, true)
      assert.equal(valid.structuredContent._id, `${name}/${valid.structuredContent._key}`)
      assert.deepEqual(valid.structuredContent.new.kind, 'note')
      assert.deepEqual(valid.structuredContent.new.count, 1)
      assert.deepEqual(valid.structuredContent.new.status, 'draft')

      const key = valid.structuredContent._key
      const read = await callCollection(tools, 'getDocument', { collection: name, key })
      assert.equal(read.structuredContent.kind, 'note')
      assert.equal(read.structuredContent.count, 1)
      assert.equal(read.structuredContent.status, 'draft')
      assert.equal('unexpected' in read.structuredContent, false)

      assertSchemaError(await callCollection(tools, 'createDocument', {
        collection: name,
        _body: { kind: 'note', status: 'draft' }
      }))
      assertSchemaError(await callCollection(tools, 'createDocument', {
        collection: name,
        _body: { kind: 'note', count: 1, unexpected: true }
      }))
      assertSchemaError(await callCollection(tools, 'createDocument', {
        collection: name,
        _body: { kind: 'wrong', count: '1' }
      }))

      const update = await callCollection(tools, 'updateDocument', {
        collection: name,
        key,
        returnNew: true,
        _body: { status: 'done', count: 2 }
      })
      assert.notEqual(update.structuredContent.error, true)
      assert.equal(update.structuredContent.new.kind, 'note')
      assert.equal(update.structuredContent.new.count, 2)
      assert.equal(update.structuredContent.new.status, 'done')

      assertSchemaError(await callCollection(tools, 'updateDocument', {
        collection: name,
        key,
        _body: { count: 'bad' }
      }))
      assertSchemaError(await callCollection(tools, 'updateDocument', {
        collection: name,
        key,
        _body: { extra: 'not allowed' }
      }))

      assertSchemaError(await callCollection(tools, 'replaceDocument', {
        collection: name,
        key,
        _body: { kind: 'note' }
      }))

      const replace = await callCollection(tools, 'replaceDocument', {
        collection: name,
        key,
        returnNew: true,
        _body: { kind: 'note', count: 3, status: 'draft' }
      })
      assert.notEqual(replace.structuredContent.error, true)
      assert.deepEqual({
        kind: replace.structuredContent.new.kind,
        count: replace.structuredContent.new.count,
        status: replace.structuredContent.new.status
      }, { kind: 'note', count: 3, status: 'draft' })

      const del = await callCollection(tools, 'deleteDocument', { collection: name, key })
      assert.notEqual(del.structuredContent.error, true)
      assert.equal(del.structuredContent._key, key)

      const missing = await callCollection(tools, 'getDocument', { collection: name, key })
      assert.equal(missing.structuredContent.error, true)
      assert.equal(missing.structuredContent.code, 404)
    } finally {
      await callCollection(tools, 'deleteCollection', { 'collection-name': name })
      conn.close()
    }
  })
})
