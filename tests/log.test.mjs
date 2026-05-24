import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBus } from '../src/bus.mjs'
import { createLogger } from '../src/log.mjs'

function waitForAsyncLog() {
  return new Promise(resolve => setImmediate(resolve))
}

async function captureStderr(fn) {
  const original = process.stderr.write
  let output = ''
  process.stderr.write = (chunk, encoding, callback) => {
    output += String(chunk)
    if (typeof encoding === 'function') encoding()
    if (typeof callback === 'function') callback()
    return true
  }
  try {
    await fn()
    await waitForAsyncLog()
    return output
  } finally {
    process.stderr.write = original
  }
}

async function sendPing(bus) {
  bus.handle('validate', msg => msg)
  bus.handle('route', () => ({ ok: true }))
  const reqId = bus.newRequest()
  const msg = await bus.send('validate', { jsonrpc: '2.0', id: 1, method: 'ping' }, reqId)
  return bus.send('route', msg, reqId)
}

async function sendFailedRoute(bus) {
  bus.handle('validate', msg => msg)
  bus.handle('route', () => { throw new Error('route failed') })
  const reqId = bus.newRequest()
  const msg = await bus.send('validate', { jsonrpc: '2.0', id: 2, method: 'ping' }, reqId)
  await assert.rejects(() => bus.send('route', msg, reqId), /route failed/)
}

async function sendFailedValidate(bus) {
  bus.handle('validate', () => { throw new Error('bad request') })
  const reqId = bus.newRequest()
  await assert.rejects(
    () => bus.send('validate', { jsonrpc: '2.0', id: 3, method: 'ping' }, reqId),
    /bad request/
  )
}

describe('logger', () => {
  it('keeps stderr silent when logLevel is silent', async () => {
    const bus = createBus()
    createLogger(bus, { logLevel: 'silent' })

    const output = await captureStderr(() => sendPing(bus))

    assert.equal(output, '')
  })

  it('writes one request summary at info level', async () => {
    const bus = createBus()
    createLogger(bus, { logLevel: 'info' })

    const output = await captureStderr(() => sendPing(bus))

    assert.match(output, /^INFO req_1 ping completed \d+ms \[validate:\d+ms route:\d+ms\]\n$/)
  })

  it('writes per-event lines plus summary at debug level', async () => {
    const bus = createBus()
    createLogger(bus, { logLevel: 'debug' })

    const output = await captureStderr(() => sendPing(bus))

    assert.match(output, /DEBUG req_1 validate completed \d+ms/)
    assert.match(output, /DEBUG req_1 route completed \d+ms/)
    assert.match(output, /INFO req_1 ping completed \d+ms \[validate:\d+ms route:\d+ms\]/)
  })

  it('warn suppresses successful requests but keeps failed request summaries', async () => {
    const okBus = createBus()
    createLogger(okBus, { logLevel: 'warn' })
    const okOutput = await captureStderr(() => sendPing(okBus))
    assert.equal(okOutput, '')

    const failBus = createBus()
    createLogger(failBus, { logLevel: 'warn' })
    const failOutput = await captureStderr(() => sendFailedRoute(failBus))
    assert.match(failOutput, /^ERROR req_1 ping failed \d+ms \[validate:\d+ms route:\d+ms!\] route failed\n$/)
  })

  it('error keeps only failed observations', async () => {
    const okBus = createBus()
    createLogger(okBus, { logLevel: 'error' })
    const okOutput = await captureStderr(() => sendPing(okBus))
    assert.equal(okOutput, '')

    const failBus = createBus()
    createLogger(failBus, { logLevel: 'error' })
    const failOutput = await captureStderr(() => sendFailedValidate(failBus))
    assert.match(failOutput, /^ERROR req_1 validate failed \d+ms bad request\n$/)
  })

  it('trace writes structured event records to stderr', async () => {
    const bus = createBus()
    createLogger(bus, { logLevel: 'trace' })

    const output = await captureStderr(() => sendPing(bus))

    const records = output.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.map(record => record.event), ['validate', 'route', 'request'])
    assert.deepEqual(records.map(record => record.severityText), ['DEBUG', 'DEBUG', 'INFO'])
    for (const record of records) {
      assert.equal(record.reqId, 'req_1')
      assert.equal(typeof record.severityNumber, 'number')
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'payload'), false)
    }
  })

  it('writes structured audit records without payloads', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mcp-log-test-'))
    const auditFile = join(tmp, 'audit.jsonl')
    try {
      const bus = createBus()
      createLogger(bus, { logLevel: 'silent', auditFile })

      await sendPing(bus)
      await waitForAsyncLog()

      const records = readFileSync(auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.deepEqual(records.map(record => record.event), ['validate', 'route'])
      for (const record of records) {
        assert.equal(record.reqId, 'req_1')
        assert.equal(typeof record.severityNumber, 'number')
        assert.equal(typeof record.severityText, 'string')
        assert.equal(record.status, 'completed')
        assert.equal(typeof record.duration, 'number')
        assert.equal(Object.prototype.hasOwnProperty.call(record, 'payload'), false)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
