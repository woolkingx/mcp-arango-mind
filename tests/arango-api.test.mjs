import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createBus } from '../src/bus.mjs'
import { createConnection } from '../src/connection.mjs'
import { createArangoApi } from '../src/arango-api.mjs'

const openapiSpec = JSON.parse(readFileSync(new URL('../arango/schema/arango.openapi.schema.json', import.meta.url), 'utf8'))

describe('Arango API schema/runtime', () => {
  it('owns the OpenAPI operation registry', () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    const op = arangoApi.getOperation('getServerAvailability')
    assert.equal(op.method, 'GET')
    assert.equal(op.pathTemplate, '/_admin/server/availability')
  })

  it('executes an operation through the connection module', async () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    let captured = null
    conn.request = async (method, path, opts) => {
      captured = { method, path, opts }
      return { status: 200, data: { mode: 'readonly' } }
    }
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    const data = await arangoApi.callOperation('getServerAvailability', {})
    assert.deepEqual(data, { mode: 'readonly' })
    assert.deepEqual(captured, { method: 'GET', path: '/_admin/server/availability', opts: { headers: {}, body: undefined } })
  })

  it('constructs HEAD operation requests', async () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    let captured = null
    conn.request = async (method, path, opts) => {
      captured = { method, path, opts }
      return { status: 200, data: null }
    }
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    await arangoApi.callOperation('getDocumentHeader', {
      collection: 'notes',
      key: 'abc',
      'If-None-Match': '"rev"'
    })
    assert.deepEqual(captured, {
      method: 'HEAD',
      path: '/_db/_system/_api/document/notes/abc',
      opts: { headers: { 'If-None-Match': '"rev"' }, body: undefined }
    })
  })

  it('preserves slash separators in composite Arango path identifiers', async () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    let captured = null
    conn.request = async (method, path, opts) => {
      captured = { method, path, opts }
      return { status: 200, data: { id: 'notes/123' } }
    }
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    await arangoApi.callOperation('deleteIndex', { 'index-id': 'notes/123' })
    assert.deepEqual(captured, {
      method: 'DELETE',
      path: '/_db/_system/_api/index/notes/123',
      opts: { headers: {}, body: undefined }
    })
  })

  it('passes non-JSON request bodies with their OpenAPI content type', async () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    let captured = null
    conn.request = async (method, path, opts) => {
      captured = { method, path, opts }
      return { status: 200, data: { result: true } }
    }
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    await arangoApi.callOperation('executeCode', { _body: 'return 1' })
    assert.deepEqual(captured, {
      method: 'POST',
      path: '/_db/_system/_admin/execute',
      opts: { headers: { 'content-type': 'text/javascript' }, body: 'return 1' }
    })
  })

  it('does not inject OpenAPI server-side defaults into request bodies', async () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    let captured = null
    conn.request = async (method, path, opts) => {
      captured = { method, path, opts }
      return { status: 200, data: { name: 'zz_defaults_probe' } }
    }
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    const data = await arangoApi.callOperation('createCollection', { name: 'zz_defaults_probe', type: 2 })
    assert.deepEqual(data, { name: 'zz_defaults_probe' })
    assert.equal(captured.method, 'POST')
    assert.equal(captured.path, '/_db/_system/_api/collection')
    assert.equal(captured.opts.body.name, 'zz_defaults_probe')
    assert.equal(captured.opts.body.type, 2)
    assert.equal('shardKeys' in captured.opts.body, false)
  })

  it('projects collection schema registration into request bodies', async () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    let captured = null
    conn.request = async (method, path, opts) => {
      captured = { method, path, opts }
      return { status: 200, data: { name: 'notes' } }
    }
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    await arangoApi.callOperation('updateCollectionProperties', {
      'collection-name': 'notes',
      schema: {
        level: 'strict',
        message: 'kind required',
        rule: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { type: 'string' } }
        }
      }
    })
    assert.equal(captured.method, 'PUT')
    assert.equal(captured.path, '/_db/_system/_api/collection/notes/properties')
    assert.equal(captured.opts.body.schema.level, 'strict')
    assert.deepEqual(captured.opts.body.schema.rule.required, ['kind'])
  })

  it('rejects invalid collection schema level before dispatch', async () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    let called = false
    conn.request = async () => {
      called = true
      return { status: 200, data: {} }
    }
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    await assert.rejects(
      () => arangoApi.callOperation('updateCollectionProperties', {
        'collection-name': 'notes',
        schema: {
          level: 'invalid',
          rule: { type: 'object' }
        }
      }),
      /not in enum/
    )
    assert.equal(called, false)
  })

  it('rejects collection schema without a rule before dispatch', async () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    let called = false
    conn.request = async () => {
      called = true
      return { status: 200, data: {} }
    }
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    await assert.rejects(
      () => arangoApi.callOperation('updateCollectionProperties', {
        'collection-name': 'notes',
        schema: { level: 'strict' }
      }),
      /missing required "rule"/
    )
    assert.equal(called, false)
  })

  it('rejects fields outside the OpenAPI operation input schema', async () => {
    const bus = createBus()
    const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
    conn.request = async () => ({ status: 200, data: {} })
    const arangoApi = createArangoApi(bus, conn, openapiSpec)
    await assert.rejects(
      () => arangoApi.callOperation('setDbserverMaintenance', {
        'DB-Server-ID': 'server-a',
        mode: 'maintenance',
        unexpected_probe: 123
      }),
      /additional property "unexpected_probe" not allowed/
    )
  })
})
