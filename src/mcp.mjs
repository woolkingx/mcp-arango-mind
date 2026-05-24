export const MCP_PROTOCOL_VERSION = '2025-11-25'

export function createMcp(mcpSchema) {
  const definitions = mcpSchema?.$defs || {}
  if (mcpSchema?.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error('MCP requires official 2025-11-25 JSON Schema 2020-12')
  }
  if (!definitions.Tool?.properties?.outputSchema) {
    throw new Error('MCP schema missing Tool.outputSchema')
  }
  if (!definitions.CallToolResult?.properties?.structuredContent) {
    throw new Error('MCP schema missing CallToolResult.structuredContent')
  }
  return { protocolVersion: MCP_PROTOCOL_VERSION, schema: mcpSchema, definitions }
}
