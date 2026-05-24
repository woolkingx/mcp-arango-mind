import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createMcp } from '../src/mcp.mjs'

const mcpSchema = JSON.parse(readFileSync(new URL('../mcp/schema/mcp.schema.json', import.meta.url), 'utf8'))
const referenceSchema = JSON.parse(readFileSync(new URL('../reference/mcp/2025-11-25.schema.json', import.meta.url), 'utf8'))

describe('MCP schema', () => {
  it('uses the official latest stable schema shape', () => {
    assert.equal(mcpSchema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.ok(Object.keys(mcpSchema.$defs).length >= 140)
    assert.ok(mcpSchema.$defs.Tool.properties.outputSchema)
    assert.ok(mcpSchema.$defs.CallToolResult.properties.structuredContent)
  })

  it('active schema matches the official reference snapshot', () => {
    assert.deepEqual(mcpSchema, referenceSchema)
  })

  it('declares MCP protocol version 2025-11-25', () => {
    const mcp = createMcp(mcpSchema)
    assert.equal(mcp.protocolVersion, '2025-11-25')
  })
})
