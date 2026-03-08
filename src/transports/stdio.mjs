// transports/stdio.mjs — stdin/stdout JSON-RPC adapter

import { createInterface } from 'node:readline'

export function startStdio(core) {
  const rl = createInterface({ input: process.stdin })

  rl.on('line', async (line) => {
    if (!line.trim()) return
    try {
      const message = JSON.parse(line)
      const response = await core.handle(message)
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n')
      }
    } catch (err) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'Parse error' }
      }) + '\n')
    }
  })

  process.on('SIGINT', () => { core.close(); process.exit(0) })
  process.on('SIGTERM', () => { core.close(); process.exit(0) })
}
