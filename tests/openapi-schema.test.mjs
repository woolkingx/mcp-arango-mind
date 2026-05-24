import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createBus } from '../src/bus.mjs'
import { createConnection } from '../src/connection.mjs'
import { createArangoApi } from '../src/arango-api.mjs'

const arangoSchema = JSON.parse(readFileSync(new URL('../arango/schema/arango.openapi.schema.json', import.meta.url), 'utf8'))

function operationIdsFromSpec() {
  const ids = []
  for (const methods of Object.values(arangoSchema.paths)) {
    for (const op of Object.values(methods)) {
      if (op?.operationId) ids.push(op.operationId)
    }
  }
  return ids
}

function makeArangoApi() {
  const bus = createBus()
  const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
  return createArangoApi(bus, conn, arangoSchema)
}

describe('Arango API Schema', () => {
  it('operation map covers community OpenAPI operationIds', () => {
    const arangoApi = makeArangoApi()
    const specOperationIds = operationIdsFromSpec()
    assert.equal(arangoApi.operations.size, specOperationIds.length)
    for (const id of specOperationIds) {
      assert.ok(arangoApi.getOperation(id), `${id} must be registered`)
    }
  })

  it('getServerAvailability is the minimal read-only tool operation', () => {
    const arangoApi = makeArangoApi()
    const op = arangoApi.getOperation('getServerAvailability')
    assert.equal(op.method, 'GET')
    assert.equal(op.pathTemplate, '/_admin/server/availability')
    assert.equal(op.inputSchema.type, 'object')
  })

  it('operation input schemas are object schemas', () => {
    const arangoApi = makeArangoApi()
    for (const [name, op] of arangoApi.operations) {
      assert.equal(op.inputSchema.type, 'object', `${name} input schema must be an object`)
      assert.ok(op.inputSchema.properties, `${name} input schema must expose properties`)
    }
  })

  it('registers HEAD operations from the OpenAPI schema', () => {
    const arangoApi = makeArangoApi()
    const op = arangoApi.getOperation('getDocumentHeader')
    assert.equal(op.method, 'HEAD')
    assert.equal(op.pathTemplate, '/_db/{database-name}/_api/document/{collection}/{key}')
  })
})
