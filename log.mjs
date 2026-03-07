// Bus subscriber: route log messages to stderr (debug) and/or file (audit)

import { appendFileSync } from 'node:fs'

export function createLogger(bus, options = {}) {
  const { auditFile, debug } = options

  bus.handle('log', (msg) => {
    if (debug) {
      const ts = new Date(msg.ts).toISOString()
      const err = msg.error ? ` ERROR: ${msg.error}` : ''
      process.stderr.write(`[${ts}][${msg.event}] ${msg.status} ${msg.duration}ms${err}\n`)
    }

    if (auditFile) {
      const { payload, ...record } = msg
      appendFileSync(auditFile, JSON.stringify(record) + '\n')
    }
  })
}
