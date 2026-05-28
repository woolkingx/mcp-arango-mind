import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv, profileFromEnv } from '../src/env.mjs'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixturePath = resolve(repoRoot, 'tests/fixtures/stdio/atlas-types.jsonl')

loadEnv()
const env = profileFromEnv()
const SKIP = !env.url
if (SKIP) console.log('# SKIP: No ARANGO_URL in .env - stdio e2e tests skipped')

function loadJsonl(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (err) {
        throw new Error(`${path}:${index + 1}: ${err.message}`)
      }
    })
}

function atPath(value, path) {
  return path.split('.').reduce((current, segment) => current?.[segment], value)
}

function assertObjectIncludes(array, expected) {
  assert.ok(Array.isArray(array), `expected array, got ${typeof array}`)
  const found = array.some(item => {
    if (!item || typeof item !== 'object') return false
    return Object.entries(expected).every(([key, value]) => item[key] === value)
  })
  assert.ok(found, `expected array to include object ${JSON.stringify(expected)}`)
}

function assertResponse(response, expect) {
  if (expect.ok) {
    assert.equal(response.error, undefined)
    assert.equal(response.result?.isError, false)
  }

  for (const [path, expected] of Object.entries(expect.equals || {})) {
    assert.deepEqual(atPath(response, path), expected, path)
  }

  for (const [path, expected] of Object.entries(expect.arrayIncludes || {})) {
    const actual = atPath(response, path)
    assert.ok(Array.isArray(actual), `${path} must be an array`)
    assert.ok(actual.includes(expected), `${path} must include ${expected}`)
  }

  for (const [path, expected] of Object.entries(expect.arrayObjectIncludes || {})) {
    assertObjectIncludes(atPath(response, path), expected)
  }
}

function createStdioSession() {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const stderr = []
  const waiting = []

  child.stderr.on('data', chunk => stderr.push(String(chunk)))

  const stdout = createInterface({ input: child.stdout })
  stdout.on('line', line => {
    const next = waiting.shift()
    if (!next) return
    try {
      next.resolve(JSON.parse(line))
    } catch (err) {
      next.reject(new Error(`invalid JSON-RPC response: ${err.message}: ${line}`))
    }
  })

  child.on('exit', (code, signal) => {
    const err = new Error(`server exited before response: code=${code} signal=${signal} stderr=${stderr.join('')}`)
    while (waiting.length) waiting.shift().reject(err)
  })

  async function call(request) {
    const response = new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        rejectResponse(new Error(`timed out waiting for response id=${request.id} stderr=${stderr.join('')}`))
      }, 5000)
      waiting.push({
        resolve: value => {
          clearTimeout(timer)
          resolveResponse(value)
        },
        reject: err => {
          clearTimeout(timer)
          rejectResponse(err)
        }
      })
    })
    child.stdin.write(JSON.stringify(request) + '\n')
    return await response
  }

  async function close() {
    if (child.exitCode !== null) return
    await new Promise(resolveClose => {
      child.once('exit', resolveClose)
      child.kill('SIGTERM')
    })
  }

  return { call, close }
}

describe('stdio e2e fixture replay', { skip: SKIP }, () => {
  it('replays atlas.types JSON-RPC fixtures through the real server and Arango parser', async () => {
    const cases = loadJsonl(fixturePath)
    const session = createStdioSession()
    try {
      for (const testCase of cases) {
        const response = await session.call(testCase.request)
        assertResponse(response, testCase.expect)
      }
    } finally {
      await session.close()
    }
  })
})
