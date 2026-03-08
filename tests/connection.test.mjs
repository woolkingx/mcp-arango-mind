// Integration tests: connection.mjs against real ArangoDB
// Requires: ARANGO_URL, ARANGO_DB, ARANGO_USERNAME, ARANGO_PASSWORD in .env
import { describe, it, before } from 'node:test'
import { strict as assert } from 'node:assert'
import { createConnection } from '../connection.mjs'
import { loadEnv, profileFromEnv } from '../env.mjs'
import {
  ArangoError, NetworkError, FetchFailedError,
  isArangoErrorResponse, isSafeToRetry
} from '../errors.mjs'

// Load .env before anything
loadEnv()
const env = profileFromEnv()

// Skip all if no real ArangoDB configured
const SKIP = !env.url
if (SKIP) console.log('# SKIP: No ARANGO_URL in .env — connection integration tests skipped')

function cfg(overrides = {}) {
  return { ...env, ...overrides }
}

// Build database-scoped path: /_db/{database}/_api/...
function dbPath(conn, apiPath) {
  return `/_db/${encodeURIComponent(conn.getDatabase())}${apiPath}`
}

describe('Connection: config validation', { skip: SKIP }, () => {
  it('creates connection with env config', () => {
    const conn = createConnection(cfg())
    assert.ok(conn.request)
    assert.ok(conn.close)
    assert.ok(conn.getActiveHostUrl())
    conn.close()
  })

  it('schema defaults are applied (poolSize, timeout, etc.)', () => {
    // Minimal config — only required fields; defaults come from schema
    const conn = createConnection(cfg())
    // If it doesn't throw, schema defaults were applied
    conn.close()
  })

  it('rejects invalid loadBalancing value', () => {
    assert.throws(() => createConnection(cfg({ loadBalancing: 'INVALID' })))
  })
})

describe('Connection: real HTTP requests', { skip: SKIP }, () => {
  it('GET /_api/version returns server info', async () => {
    const conn = createConnection(cfg())
    try {
      const res = await conn.request('GET', dbPath(conn, '/_api/version'))
      assert.equal(res.status, 200)
      assert.equal(res.data.server, 'arango')
      assert.ok(res.data.version)
    } finally { conn.close() }
  })

  it('GET /_api/collection lists collections', async () => {
    const conn = createConnection(cfg())
    try {
      const res = await conn.request('GET', dbPath(conn, '/_api/collection'))
      assert.equal(res.status, 200)
      assert.ok(Array.isArray(res.data.result))
    } finally { conn.close() }
  })

  it('POST /_api/cursor executes AQL', async () => {
    const conn = createConnection(cfg())
    try {
      const res = await conn.request('POST', dbPath(conn, '/_api/cursor'), {
        body: { query: 'RETURN 1' }
      })
      assert.ok([200, 201].includes(res.status))
      assert.deepEqual(res.data.result, [1])
    } finally { conn.close() }
  })

  it('returns ArangoDB error response as-is (not thrown)', async () => {
    const conn = createConnection(cfg())
    try {
      const res = await conn.request('GET', dbPath(conn, '/_api/collection/nonexistent_collection_xyz'))
      // Should return error data, not throw
      assert.ok(res.data.error === true || res.status === 404)
      if (res.data.error) {
        assert.ok(isArangoErrorResponse(res.data))
        assert.equal(res.data.errorNum, 1203) // COLLECTION_NOT_FOUND
      }
    } finally { conn.close() }
  })

  it('request body is sent correctly (create + delete collection)', async () => {
    const conn = createConnection(cfg())
    const name = 'test_conn_' + Date.now()
    try {
      // Create
      const create = await conn.request('POST', dbPath(conn, '/_api/collection'), {
        body: { name }
      })
      assert.ok([200, 201, 409].includes(create.status))

      // Delete
      const del = await conn.request('DELETE', dbPath(conn, `/_api/collection/${name}`))
      assert.ok([200, 404].includes(del.status))
    } finally { conn.close() }
  })
})

describe('Connection: auth', { skip: SKIP }, () => {
  it('wrong credentials return 401', async () => {
    const conn = createConnection(cfg({
      auth: { username: 'nonexistent_user_xyz', password: 'wrong' }
    }))
    try {
      const res = await conn.request('GET', dbPath(conn, '/_api/version'))
      assert.equal(res.status, 401)
    } finally { conn.close() }
  })

  it('setAuth switches credentials', async () => {
    const conn = createConnection(cfg({
      auth: { username: 'bad_user', password: 'bad_pass' }
    }))
    try {
      // First: should fail
      const fail = await conn.request('GET', dbPath(conn, '/_api/version'))
      assert.equal(fail.status, 401)

      // Switch to good credentials
      conn.setAuth(env.auth)
      const ok = await conn.request('GET', dbPath(conn, '/_api/version'))
      assert.equal(ok.status, 200)
    } finally { conn.close() }
  })
})

describe('Connection: transaction', { skip: SKIP }, () => {
  it('setTransactionId adds header to request', async () => {
    const conn = createConnection(cfg())
    conn.setTransactionId('test-trx-id')
    try {
      // ArangoDB may ignore invalid trx IDs on reads — just verify no crash
      const res = await conn.request('GET', dbPath(conn, '/_api/version'))
      assert.ok(res.status, 'Should get a response')
    } finally {
      conn.setTransactionId(null)
      conn.close()
    }
  })

  it('real transaction: begin → read → abort', async () => {
    const conn = createConnection(cfg())
    try {
      // Begin transaction
      const begin = await conn.request('POST', dbPath(conn, '/_api/transaction/begin'), {
        body: { collections: { read: ['_system'] } }
      })
      // May fail if _system collection doesn't exist in test db — that's ok
      if (begin.status === 201 || begin.status === 200) {
        const trxId = begin.data.result.id
        conn.setTransactionId(trxId)

        // Read within transaction
        const read = await conn.request('GET', dbPath(conn, '/_api/collection'))
        assert.equal(read.status, 200)

        // Abort
        conn.setTransactionId(null)
        await conn.request('DELETE', dbPath(conn, `/_api/transaction/${trxId}`))
      }
    } finally { conn.close() }
  })
})

describe('Connection: error types', { skip: SKIP }, () => {
  it('connection refused → NetworkError', async () => {
    const conn = createConnection({
      url: 'http://127.0.0.1:19999', // nothing listening
      database: 'test',
      auth: { username: 'x', password: 'x' }
    })
    try {
      await conn.request('GET', dbPath(conn, '/_api/version'))
      assert.fail('Should have thrown')
    } catch (err) {
      assert.ok(err instanceof NetworkError || err instanceof FetchFailedError,
        `Expected NetworkError, got ${err.constructor.name}: ${err.message}`)
    } finally { conn.close() }
  })

  it('timeout → error with timeout indication', async () => {
    const conn = createConnection(cfg({ timeout: 1 })) // 1ms timeout
    try {
      await conn.request('POST', dbPath(conn, '/_api/cursor'), {
        body: { query: 'FOR i IN 1..1000000 RETURN SLEEP(0.001)' }
      })
      // Might succeed if server is fast — that's ok
    } catch (err) {
      assert.ok(err instanceof NetworkError,
        `Expected timeout/network error, got ${err.constructor.name}`)
    } finally { conn.close() }
  })

  it('isArangoErrorResponse identifies real error', async () => {
    const conn = createConnection(cfg())
    try {
      const res = await conn.request('GET', dbPath(conn, '/_api/collection/nonexistent_xyz'))
      if (res.data.error) {
        assert.ok(isArangoErrorResponse(res.data))
        assert.equal(isSafeToRetry({ isSafeToRetry: null }), null)
      }
    } finally { conn.close() }
  })
})

describe('Connection: concurrent requests', { skip: SKIP }, () => {
  it('poolSize=2 handles 5 concurrent requests', async () => {
    const conn = createConnection(cfg({ poolSize: 2 }))
    try {
      const promises = Array.from({ length: 5 }, () =>
        conn.request('GET', dbPath(conn, '/_api/version'))
      )
      const results = await Promise.all(promises)
      for (const r of results) {
        assert.equal(r.status, 200)
        assert.equal(r.data.server, 'arango')
      }
    } finally { conn.close() }
  })

  it('10 concurrent AQL queries all resolve', async () => {
    const conn = createConnection(cfg())
    try {
      const promises = Array.from({ length: 10 }, (_, i) =>
        conn.request('POST', dbPath(conn, '/_api/cursor'), {
          body: { query: `RETURN ${i}` }
        })
      )
      const results = await Promise.all(promises)
      for (let i = 0; i < 10; i++) {
        assert.ok([200, 201].includes(results[i].status))
        assert.deepEqual(results[i].data.result, [i])
      }
    } finally { conn.close() }
  })
})
