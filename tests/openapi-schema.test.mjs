// Test 2: OpenAPI tool generation — every tool matches MCP Tool schema
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ObjectTree } from '../lib/schema2object.mjs'
import { createBus } from '../bus.mjs'
import { createPool } from '../pool.mjs'
import { createDispatch } from '../dispatch.mjs'

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
  const pool = createPool({ url: 'http://localhost:8529', database: '_system', auth: { username: 'root', password: '' } })
  return createDispatch(bus, pool, openapiSpec)
}

describe('OpenAPI Tool Generation', () => {

  it('generates tools from OpenAPI spec', () => {
    const { getToolList } = makeDispatch()
    const tools = getToolList()
    assert.ok(tools.length > 200, `Expected 200+ tools, got ${tools.length}`)
  })

  it('every tool has required fields: name, inputSchema', () => {
    const { getToolList } = makeDispatch()
    const tools = getToolList()
    for (const tool of tools) {
      assert.ok(tool.name, `Tool missing name`)
      assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`)
      assert.equal(tool.inputSchema.type, 'object', `Tool ${tool.name} inputSchema.type must be "object"`)
    }
  })

  it('every tool matches MCP Tool schema', () => {
    const { getToolList } = makeDispatch()
    const tools = getToolList()
    let validated = 0
    for (const tool of tools) {
      new ObjectTree(tool, mcpDef('Tool'))
      validated++
    }
    assert.ok(validated > 200, `Validated ${validated} tools`)
  })

  it('tool names are unique', () => {
    const { getToolList } = makeDispatch()
    const tools = getToolList()
    const names = new Set()
    for (const tool of tools) {
      assert.ok(!names.has(tool.name), `Duplicate tool name: ${tool.name}`)
      names.add(tool.name)
    }
  })

  it('tool inputSchema properties match OpenAPI parameters', () => {
    const { getToolList, operations } = makeDispatch()
    const tools = getToolList()
    for (const tool of tools) {
      const op = operations.get(tool.name)
      if (!op) continue
      // Every path param should be in inputSchema.required
      for (const p of op.pathParams) {
        assert.ok(
          tool.inputSchema.required?.includes(p.name),
          `Tool ${tool.name}: path param "${p.name}" should be required`
        )
      }
      // Every param should be in inputSchema.properties
      for (const p of op.parameters) {
        assert.ok(
          tool.inputSchema.properties?.[p.name],
          `Tool ${tool.name}: param "${p.name}" should be in properties`
        )
      }
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
})
