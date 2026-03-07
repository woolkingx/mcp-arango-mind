// MCP JSON-RPC protocol handler

function jsonrpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export function createProtocol(bus, mcpSchema, toolList) {

  bus.handle('validate', (msg) => {
    if (msg.jsonrpc !== '2.0') {
      throw new Error('Invalid JSON-RPC: missing jsonrpc 2.0')
    }
    if (!msg.method || typeof msg.method !== 'string') {
      throw new Error('Invalid JSON-RPC: missing method')
    }
    return msg
  })

  bus.handle('route', async (msg) => {
    const { method, params, id } = msg

    switch (method) {
      case 'initialize':
        return jsonrpcResult(id, {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mcp-arango-mind', version: '1.0.0' }
        })

      case 'notifications/initialized':
        return null

      case 'tools/list':
        return jsonrpcResult(id, { tools: toolList })

      case 'tools/call': {
        const name = params.name
        const args = params.arguments || {}
        try {
          const result = await bus.send('dispatch', { name, arguments: args })
          return jsonrpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }]
          })
        } catch (err) {
          return jsonrpcResult(id, {
            content: [{ type: 'text', text: 'Error: ' + err.message }],
            isError: true
          })
        }
      }

      case 'ping':
        return jsonrpcResult(id, {})

      default:
        return jsonrpcError(id, -32601, 'Method not found')
    }
  })
}
