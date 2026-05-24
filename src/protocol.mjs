import { readFileSync } from 'node:fs'
import { ObjectTree } from './lib/schema2object.mjs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

class ProtocolError extends Error {
  constructor(code, message, id = null) {
    super(message)
    this.code = code
    this.id = id
  }
}

const REQUEST_SCHEMAS = new Map([
  ['initialize', 'InitializeRequest'],
  ['tools/list', 'ListToolsRequest'],
  ['tools/call', 'CallToolRequest'],
  ['resources/list', 'ListResourcesRequest'],
  ['resources/read', 'ReadResourceRequest'],
  ['ping', 'PingRequest']
])

const NOTIFICATION_SCHEMAS = new Map([
  ['notifications/initialized', 'InitializedNotification']
])

function jsonrpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function requestId(msg) {
  return typeof msg?.id === 'string' || Number.isInteger(msg?.id) ? msg.id : null
}

function schemaRef(definitions, name) {
  return { $ref: '#/$defs/' + name, $defs: definitions }
}

function validateMessage(msg, mcp) {
  const id = requestId(msg)
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new ProtocolError(-32600, 'Invalid JSON-RPC request', null)
  }
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    throw new ProtocolError(-32600, 'Invalid JSON-RPC request', id)
  }

  const notificationSchema = NOTIFICATION_SCHEMAS.get(msg.method)
  const requestSchema = REQUEST_SCHEMAS.get(msg.method)
  const schemaName = notificationSchema || requestSchema || 'JSONRPCRequest'
  try {
    new ObjectTree(msg, schemaRef(mcp.definitions, schemaName))
  } catch (err) {
    throw new ProtocolError(-32600, err.message, id)
  }
  return msg
}

export function createProtocol(bus, mcp, tools) {
  const { protocolVersion } = mcp
  const {
    toolList,
    callTool,
    resourceList = [],
    readResource = () => null
  } = tools

  bus.handle('validate', (msg) => {
    return validateMessage(msg, mcp)
  })

  bus.handle('route', async (msg, reqId) => {
    const { method, params, id } = msg

    switch (method) {
      case 'initialize':
        return jsonrpcResult(id, {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false }
          },
          serverInfo: { name: packageJson.name, version: packageJson.version }
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
        const result = readResource(uri)
        if (result) return jsonrpcResult(id, result)
        return jsonrpcError(id, -32602, `Unknown resource: ${uri}`)
      }

      case 'tools/call': {
        const name = params?.name
        if (!name) return jsonrpcError(id, -32602, 'Missing tool name')
        try {
          const result = await callTool(name, params.arguments || {})
          if (!result) return jsonrpcError(id, -32602, `Unknown tool: ${name}`)
          return jsonrpcResult(id, result)
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
