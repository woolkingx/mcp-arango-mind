import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const url = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-11-25/schema.json'
const res = await fetch(url)
if (!res.ok) throw new Error(`failed to fetch MCP schema: ${res.status} ${url}`)

const text = await res.text()
const schema = JSON.parse(text)
const defs = schema.$defs || {}

if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
  throw new Error(`unexpected MCP schema dialect: ${schema.$schema}`)
}
if (!defs.Tool?.properties?.outputSchema) throw new Error('MCP Tool.outputSchema missing')
if (!defs.CallToolResult?.properties?.structuredContent) throw new Error('MCP CallToolResult.structuredContent missing')

mkdirSync(new URL('../reference/mcp/', import.meta.url), { recursive: true })
mkdirSync(new URL('../mcp/schema/', import.meta.url), { recursive: true })
writeFileSync(new URL('../reference/mcp/2025-11-25.schema.json', import.meta.url), JSON.stringify(schema, null, 2) + '\n')
writeFileSync(new URL('../mcp/schema/mcp.schema.json', import.meta.url), JSON.stringify(schema, null, 2) + '\n')
console.log(JSON.stringify({
  source: url,
  sha256: createHash('sha256').update(text).digest('hex'),
  definitions: Object.keys(defs).length
}, null, 2))
