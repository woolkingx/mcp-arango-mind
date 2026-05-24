import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createBus } from '../src/bus.mjs'
import { createConnection } from '../src/connection.mjs'
import { createArangoApi } from '../src/arango-api.mjs'
import { createArangoSurfaceHandlers } from '../src/arango-surface.mjs'

const openapiSpec = JSON.parse(readFileSync(new URL('../arango/schema/arango.openapi.schema.json', import.meta.url), 'utf8'))

function buildApi() {
  const bus = createBus()
  const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
  return { conn, arangoApi: createArangoApi(bus, conn, openapiSpec) }
}

describe('arango surface handlers', () => {
  it('lists operations with a default limit', () => {
    const { arangoApi } = buildApi()
    const handlers = createArangoSurfaceHandlers(arangoApi)
    const result = handlers['arangoSurface.list']({})
    assert.equal(result.limit, 50)
    assert.equal(result.operations.length, 50)
    assert.ok(result.operations[0].operationId)
  })

  it('respects an explicit limit and tag filter', () => {
    const { arangoApi } = buildApi()
    const handlers = createArangoSurfaceHandlers(arangoApi)
    const result = handlers['arangoSurface.list']({ limit: 5, tags: ['Administration'] })
    assert.ok(result.operations.length <= 5)
    for (const op of result.operations) {
      assert.ok(op.tags.includes('Administration'))
    }
  })

  it('searches by keyword across operationId and summary', () => {
    const { arangoApi } = buildApi()
    const handlers = createArangoSurfaceHandlers(arangoApi)
    const result = handlers['arangoSurface.search']({ keywords: ['availability'] })
    assert.ok(result.operations.some(op => op.operationId === 'getServerAvailability'))
  })

  it('searches with a single query string', () => {
    const { arangoApi } = buildApi()
    const handlers = createArangoSurfaceHandlers(arangoApi)
    const result = handlers['arangoSurface.search']({ query: 'server availability' })
    assert.ok(result.operations.some(op => op.operationId === 'getServerAvailability'))
  })

  it('rejects empty search input', () => {
    const { arangoApi } = buildApi()
    const handlers = createArangoSurfaceHandlers(arangoApi)
    assert.throws(
      () => handlers['arangoSurface.search']({ query: '   ' }),
      /search requires a non-empty query or keywords/
    )
    assert.throws(
      () => handlers['arangoSurface.search']({ keywords: [] }),
      /search requires a non-empty query or keywords/
    )
    assert.throws(
      () => handlers['arangoSurface.search']({ keywords: [''] }),
      /search requires a non-empty query or keywords/
    )
  })

  it('describes a known operationId', () => {
    const { arangoApi } = buildApi()
    const handlers = createArangoSurfaceHandlers(arangoApi)
    const result = handlers['arangoSurface.describe']({ target: 'getServerAvailability' })
    assert.equal(result.operationId, 'getServerAvailability')
    assert.equal(result.method, 'GET')
    assert.equal(result.path, '/_admin/server/availability')
  })

  it('rejects describe for an unknown operationId', () => {
    const { arangoApi } = buildApi()
    const handlers = createArangoSurfaceHandlers(arangoApi)
    assert.throws(
      () => handlers['arangoSurface.describe']({ target: 'notReal' }),
      /unknown operationId/
    )
  })

  it('call delegates to arangoApi.callOperation with params', async () => {
    const { arangoApi } = buildApi()
    let captured = null
    arangoApi.callOperation = async (name, args) => {
      captured = { name, args }
      return { mode: 'readonly' }
    }
    const handlers = createArangoSurfaceHandlers(arangoApi)
    const result = await handlers['arangoSurface.call']({ target: 'getServerAvailability', params: {} })
    assert.deepEqual(captured, { name: 'getServerAvailability', args: {} })
    assert.deepEqual(result, { mode: 'readonly' })
  })

  it('exec delegates to the same OpenAPI operation executor', async () => {
    const { arangoApi } = buildApi()
    let captured = null
    arangoApi.callOperation = async (name, args) => {
      captured = { name, args }
      return { mode: 'readonly' }
    }
    const handlers = createArangoSurfaceHandlers(arangoApi)
    const result = await handlers['arangoSurface.exec']({ target: 'getServerAvailability', params: {} })
    assert.deepEqual(captured, { name: 'getServerAvailability', args: {} })
    assert.deepEqual(result, { mode: 'readonly' })
  })
})
