// Test 2: OpenAPI tool generation — category tools + operation help
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ObjectTree } from '../src/lib/schema2object.mjs'
import { createBus } from '../src/bus.mjs'
import { createConnection } from '../src/connection.mjs'
import { createDispatch } from '../src/dispatch.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const configDir = join(__dirname, '..', 'config')
const mcpSchema = JSON.parse(readFileSync(join(configDir, 'mcp-schema.json'), 'utf8'))
const openapiSpec = JSON.parse(readFileSync(join(configDir, 'arango-openapi.json'), 'utf8'))
const defs = mcpSchema.definitions

function mcpDef(name) {
  return { $ref: '#/definitions/' + name, definitions: defs }
}

function makeDispatch() {
  const bus = createBus()
  const conn = createConnection({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
  return createDispatch(bus, conn, openapiSpec)
}

describe('OpenAPI Tool Generation', () => {

  it('tools/list returns category-level tools (not 252 individual)', () => {
    const { getToolList } = makeDispatch()
    const tools = getToolList()
    assert.ok(tools.length >= 20 && tools.length <= 30,
      `Expected 20-30 category tools, got ${tools.length}`)
  })

  it('every category tool has name, description, inputSchema', () => {
    const { getToolList } = makeDispatch()
    const tools = getToolList()
    for (const tool of tools) {
      assert.ok(tool.name, 'Tool missing name')
      assert.ok(tool.description, `Tool ${tool.name} missing description`)
      assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`)
      assert.equal(tool.inputSchema.type, 'object')
    }
  })

  it('every category tool matches MCP Tool schema', () => {
    const { getToolList } = makeDispatch()
    const tools = getToolList()
    for (const tool of tools) {
      new ObjectTree(tool, mcpDef('Tool'))
    }
  })

  it('category descriptions list tool names', () => {
    const { getToolList } = makeDispatch()
    const tools = getToolList()
    for (const tool of tools) {
      assert.match(tool.description, /\d+ tools:/, `${tool.name} description should show tool count`)
    }
  })

  it('tool names are unique across categories', () => {
    const { getToolList } = makeDispatch()
    const tools = getToolList()
    const names = new Set()
    for (const tool of tools) {
      assert.ok(!names.has(tool.name), `Duplicate category: ${tool.name}`)
      names.add(tool.name)
    }
  })

  it('operations map covers all OpenAPI paths with operationId', () => {
    const { operations } = makeDispatch()
    let specOps = 0
    for (const methods of Object.values(openapiSpec.paths)) {
      for (const verb of ['get', 'post', 'put', 'delete', 'patch']) {
        if (methods[verb]?.operationId) specOps++
      }
    }
    assert.equal(operations.size, specOps,
      `Operations map (${operations.size}) should match spec operationIds (${specOps})`)
  })

  it('getToolHelp returns inputSchema for each operation', () => {
    const { getToolHelp, operations } = makeDispatch()
    for (const name of operations.keys()) {
      const help = getToolHelp(name)
      assert.ok(help, `No help for ${name}`)
      assert.ok(help.inputSchema, `${name} help missing inputSchema`)
      assert.equal(help.inputSchema.type, 'object')
      assert.ok(help.http?.method, `${name} help missing http.method`)
      assert.ok(help.http?.path, `${name} help missing http.path`)
    }
  })
})
