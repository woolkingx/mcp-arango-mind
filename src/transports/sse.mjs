// transports/sse.mjs — HTTP server for MCP Streamable HTTP transport

import { createServer } from 'node:http'

export function startSSE(core, { port = 8000, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id')
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      try {
        const message = JSON.parse(body)
        const response = await core.handle(message)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(response ? JSON.stringify(response) : '')
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: 'Parse error' }
        }))
      }
      return
    }

    res.writeHead(405)
    res.end('Method not allowed')
  })

  server.listen(port, host, () => {
    process.stderr.write(`MCP SSE server listening on ${host}:${port}\n`)
  })

  process.on('SIGINT', () => { core.close(); server.close(); process.exit(0) })
  process.on('SIGTERM', () => { core.close(); server.close(); process.exit(0) })
}
