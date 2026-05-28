import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createBus } from '../src/bus.mjs'
import { createConnection } from '../src/connection.mjs'
import { createArangoApi } from '../src/arango-api.mjs'
import { createCategoryOwnerHandlers } from '../src/tool-category-owner.mjs'

const openapiSpec = JSON.parse(readFileSync(new URL('../arango/schema/arango.openapi.schema.json', import.meta.url), 'utf8'))

function buildApi() {
  const bus = createBus()
  const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
  return { conn, arangoApi: createArangoApi(bus, conn, openapiSpec) }
}

describe('category owner handlers', () => {
  it('lists operations restricted to the category tags', () => {
    const { arangoApi } = buildApi()
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'database', tags: ['Databases'] })
    const result = handlers['categoryDatabase.list']({})
    assert.equal(result.category, 'database')
    assert.ok(result.total > 0)
    for (const op of result.operations) assert.ok(op.tags.includes('Databases'))
  })

  it('searches within the category whitelist only', () => {
    const { arangoApi } = buildApi()
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'graph', tags: ['Graphs'] })
    const result = handlers['categoryGraph.search']({ keywords: ['graph'] })
    assert.ok(result.total > 0)
    for (const op of result.operations) assert.ok(op.tags.includes('Graphs'))
  })

  it('searches nested OpenAPI request body schema metadata', () => {
    const { arangoApi } = buildApi()
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] })
    const result = handlers['categoryCollection.search']({ keywords: ['schema'], limit: 20 })
    const operationIds = result.operations.map(op => op.operationId)
    assert.ok(operationIds.includes('createCollection'))
    assert.ok(operationIds.includes('updateCollectionProperties'))
    assert.equal(operationIds.includes('listCollections'), false)
  })

  it('rejects empty category search keywords', () => {
    const { arangoApi } = buildApi()
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'graph', tags: ['Graphs'] })
    assert.throws(
      () => handlers['categoryGraph.search']({ keywords: [] }),
      /graph category search requires non-empty keywords/
    )
    assert.throws(
      () => handlers['categoryGraph.search']({ keywords: [''] }),
      /graph category search requires non-empty keywords/
    )
  })

  it('describes an operation when it is inside the whitelist', () => {
    const { arangoApi } = buildApi()
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'database', tags: ['Databases'] })
    const result = handlers['categoryDatabase.describe']({ target: 'listDatabases' })
    assert.equal(result.operationId, 'listDatabases')
    assert.equal(result.category, 'database')
    assert.ok(result.tags.includes('Databases'))
  })

  it('describes collection document schema validation shape', () => {
    const { arangoApi } = buildApi()
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] })
    const result = handlers['categoryCollection.describe']({ target: 'updateCollectionProperties' })
    assert.equal(result.operationId, 'updateCollectionProperties')
    assert.deepEqual(result.bodySchema.properties.schema.properties.level.enum, ['none', 'new', 'moderate', 'strict'])
    assert.deepEqual(result.bodySchema.properties.schema.required, ['rule'])
  })

  it('rejects describe outside the whitelist', () => {
    const { arangoApi } = buildApi()
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'database', tags: ['Databases'] })
    assert.throws(
      () => handlers['categoryDatabase.describe']({ target: 'getServerAvailability' }),
      /outside database category/
    )
  })

  it('call delegates to arangoApi.callOperation for whitelisted targets', async () => {
    const { arangoApi } = buildApi()
    let captured = null
    arangoApi.callOperation = async (op, args) => {
      captured = { op, args }
      return { ok: true }
    }
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'database', tags: ['Databases'] })
    const result = await handlers['categoryDatabase.call']({ target: 'listDatabases', params: {} })
    assert.deepEqual(captured, { op: 'listDatabases', args: {} })
    assert.deepEqual(result, { ok: true })
  })

  it('rejects notes insert with invalid runtime schema type root before dispatch', async () => {
    const { arangoApi } = buildApi()
    let called = false
    arangoApi.callOperation = async () => { called = true; return {} }
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] })
    await assert.rejects(
      () => handlers['categoryCollection.call']({
        target: 'createDocument',
        params: {
          collection: 'notes',
          _body: {
            title: 'Bad runtime type root',
            content: 'This should be rejected before Arango dispatch.',
            tags: ['schema', 'runtime', 'insert'],
            type: ['project', 'runtime-schema'],
            weight: 50,
            created_at: '2026-05-24T00:00:00Z'
          }
        }
      }),
      /notes\.type\[0\].*x-first-level/
    )
    assert.equal(called, false)
  })

  it('rejects tags insert with invalid runtime schema before dispatch', async () => {
    const { arangoApi } = buildApi()
    let called = false
    arangoApi.callOperation = async () => { called = true; return {} }
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] })
    await assert.rejects(
      () => handlers['categoryCollection.call']({
        target: 'createDocument',
        params: {
          collection: 'tags',
          _body: { label: '' }
        }
      }),
      /runtime schema validation failed for tags/
    )
    assert.equal(called, false)
  })

  it('validates collection document patch bodies in partial mode', async () => {
    const { arangoApi } = buildApi()
    let captured = null
    arangoApi.callOperation = async (op, args) => {
      captured = { op, args }
      return { ok: true }
    }
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] })
    const result = await handlers['categoryCollection.call']({
      target: 'updateDocument',
      params: {
        collection: 'notes',
        key: 'note-1',
        _body: { weight: 9 }
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
    assert.deepEqual(result, { ok: true })
  })

  it('rejects invalid collection document patch fields before dispatch', async () => {
    const { arangoApi } = buildApi()
    let called = false
    arangoApi.callOperation = async () => { called = true; return {} }
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] })
    await assert.rejects(
      () => handlers['categoryCollection.call']({
        target: 'updateDocument',
        params: {
          collection: 'notes',
          key: 'note-1',
          _body: { weight: 'bad' }
        }
      }),
      /runtime schema validation failed for notes/
    )
    assert.equal(called, false)
  })

  it('does not validate non-object document read body entries as runtime documents', async () => {
    const { arangoApi } = buildApi()
    let captured = null
    arangoApi.callOperation = async (op, args) => {
      captured = { op, args }
      return { documents: [] }
    }
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] })
    const result = await handlers['categoryCollection.call']({
      target: 'getDocuments',
      params: {
        collection: 'notes',
        _body: ['note-1', 'note-2']
      }
    })
    assert.deepEqual(captured, {
      op: 'getDocuments',
      args: {
        collection: 'notes',
        _body: ['note-1', 'note-2']
      }
    })
    assert.deepEqual(result, { documents: [] })
  })

  it('call rejects targets outside the whitelist before dispatch', async () => {
    const { arangoApi } = buildApi()
    let called = false
    arangoApi.callOperation = async () => { called = true; return {} }
    const handlers = createCategoryOwnerHandlers(arangoApi, { name: 'graph', tags: ['Graphs'] })
    await assert.rejects(
      () => handlers['categoryGraph.call']({ target: 'getServerAvailability' }),
      /outside graph category/
    )
    assert.equal(called, false)
  })
})
