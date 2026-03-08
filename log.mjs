// Bus subscriber: per-event debug + per-request summary + audit file
// logLevel: 'silent' | 'info' | 'debug'  (default: 'info')

import { appendFileSync } from 'node:fs'

export function createLogger(bus, options = {}) {
  const { auditFile, logLevel = 'info' } = options

  // Collect events per request for summary log
  const requests = new Map()

  bus.handle('log', (msg) => {
    const { reqId, event, status, duration, error, ts } = msg

    // --- Debug: every event, immediately ---
    if (logLevel === 'debug') {
      const iso = new Date(ts).toISOString()
      const rid = reqId ? `[${reqId}]` : ''
      const err = error ? ` ERROR: ${error}` : ''
      process.stderr.write(`[${iso}]${rid}[${event}] ${status} ${duration}ms${err}\n`)
    }

    // --- Request summary (info + debug): collect events, emit on route completion ---
    if (logLevel !== 'silent' && reqId) {
      if (!requests.has(reqId)) {
        requests.set(reqId, { ts, events: [], method: null, tool: null })
      }
      const req = requests.get(reqId)
      req.events.push({ event, status, duration, error })

      // Extract method/tool from payload for summary
      if (event === 'validate' && msg.payload?.method) {
        req.method = msg.payload.method
      }
      if (event === 'dispatch' && msg.payload?.name) {
        req.tool = msg.payload.name
      }

      // Emit summary when route completes (it's the outermost event)
      if (event === 'route') {
        const total = Date.now() - req.ts
        const parts = req.events.map(e =>
          `${e.event}:${e.duration}ms${e.error ? '!' : ''}`
        ).join(' ')
        const label = req.tool ? `${req.method} ${req.tool}` : req.method || '?'
        const st = status === 'completed' ? '→' : '✗'
        process.stderr.write(`${reqId} ${label} ${st} ${total}ms [${parts}]\n`)
        requests.delete(reqId)
      }
    }

    // --- Audit file: every event (structured JSON) ---
    if (auditFile) {
      const { payload, ...record } = msg
      appendFileSync(auditFile, JSON.stringify(record) + '\n')
    }
  })
}
