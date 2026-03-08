// MCP JSON-RPC protocol handler

function jsonrpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export function createProtocol(bus, mcpSchema, dispatch) {
  const { toolList, dispatchCategory, resourceList, getCategories, getToolHelp } = dispatch

  bus.handle('validate', (msg) => {
    if (msg.jsonrpc !== '2.0') {
      throw new Error('Invalid JSON-RPC: missing jsonrpc 2.0')
    }
    if (!msg.method || typeof msg.method !== 'string') {
      throw new Error('Invalid JSON-RPC: missing method')
    }
    return msg
  })

  bus.handle('route', async (msg, reqId) => {
    const { method, params, id } = msg

    switch (method) {
      case 'initialize':
        return jsonrpcResult(id, {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false }
          },
          serverInfo: { name: 'mcp-arango-mind', version: '1.0.0' }
        })

      case 'notifications/initialized':
        return null

      case 'tools/list':
        return jsonrpcResult(id, { tools: toolList })

      case 'resources/list':
        return jsonrpcResult(id, { resources: resourceList })

      case 'resources/read': {
        const uri = params?.uri
        if (!uri) return jsonrpcError(id, -32602, 'Missing uri param')

        if (uri === 'tool://categories') {
          const text = JSON.stringify(getCategories(), null, 2)
          return jsonrpcResult(id, {
            contents: [{ uri, mimeType: 'application/json', text }]
          })
        }

        const helpMatch = uri.match(/^tool:\/\/help\/(.+)$/)
        if (helpMatch) {
          const help = getToolHelp(helpMatch[1])
          if (!help) return jsonrpcError(id, -32602, `Unknown tool: ${helpMatch[1]}`)
          const text = JSON.stringify(help, null, 2)
          return jsonrpcResult(id, {
            contents: [{ uri, mimeType: 'application/json', text }]
          })
        }

        return jsonrpcError(id, -32602, `Unknown resource: ${uri}`)
      }

      case 'tools/call': {
        const name = params.name
        const args = params.arguments || {}

        // Category tool: action → dispatch, no action → list
        const cat = dispatchCategory(name, args.action, args)
        if (cat) {
          if (cat.error) {
            return jsonrpcResult(id, {
              content: [{ type: 'text', text: cat.error }], isError: true
            })
          }
          if (cat.list) {
            return jsonrpcResult(id, {
              content: [{ type: 'text', text: JSON.stringify(cat.list, null, 2) }]
            })
          }
          // Forward: strip action, dispatch real operation
          const { action, ...rest } = args
          try {
            const result = await bus.send('dispatch', { name: action, arguments: rest }, reqId)
            return jsonrpcResult(id, {
              content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }]
            })
          } catch (err) {
            return jsonrpcResult(id, {
              content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true
            })
          }
        }

        // Direct operation call (fallback)
        try {
          const result = await bus.send('dispatch', { name, arguments: args }, reqId)
          return jsonrpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }]
          })
        } catch (err) {
          return jsonrpcResult(id, {
            content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true
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
