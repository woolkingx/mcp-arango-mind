// Bus subscriber: leveled stderr observations + structured audit file.
// logLevel: silent | error | warn | info | debug | trace

import { appendFileSync } from 'node:fs'

const SEVERITY = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21
}

const LEVEL_THRESHOLD = {
  silent: Infinity,
  fatal: SEVERITY.FATAL,
  error: SEVERITY.ERROR,
  warn: SEVERITY.WARN,
  info: SEVERITY.INFO,
  debug: SEVERITY.DEBUG,
  trace: SEVERITY.TRACE
}

const LEVEL_ALIASES = {
  warning: 'warn',
  err: 'error',
  verbose: 'trace',
  all: 'trace',
  none: 'silent',
  off: 'silent'
}

function normalizeLogLevel(level) {
  const raw = String(level || 'info').toLowerCase()
  const normalized = LEVEL_ALIASES[raw] || raw
  return Object.hasOwn(LEVEL_THRESHOLD, normalized) ? normalized : 'info'
}

function shouldWrite(configLevel, severityText) {
  return SEVERITY[severityText] >= LEVEL_THRESHOLD[configLevel]
}

function eventSeverity(msg) {
  if (msg.status === 'failed') return 'ERROR'
  return 'DEBUG'
}

function requestSeverity(status) {
  return status === 'failed' ? 'ERROR' : 'INFO'
}

function eventRecord(msg, severityText) {
  const { payload, ...rest } = msg
  const record = {
    timestamp: new Date(msg.ts).toISOString(),
    severityText,
    severityNumber: SEVERITY[severityText],
    ...rest
  }
  if (payload?.method) record.method = payload.method
  if (payload?.method === 'tools/call') record.tool = payload.params?.name
  return record
}

function writeEventText(record) {
  const req = record.reqId || '-'
  const err = record.error ? ` ${record.error}` : ''
  process.stderr.write(`${record.severityText} ${req} ${record.event} ${record.status} ${record.duration}ms${err}\n`)
}

function writeRecord(record) {
  process.stderr.write(JSON.stringify(record) + '\n')
}

export function createLogger(bus, options = {}) {
  const { auditFile, logLevel = 'info' } = options
  const level = normalizeLogLevel(logLevel)

  const requests = new Map()

  bus.handle('log', (msg) => {
    const { reqId, event, status, duration, error } = msg
    const severityText = eventSeverity(msg)
    const record = eventRecord(msg, severityText)

    if (level === 'trace' && shouldWrite(level, severityText)) {
      writeRecord(record)
    } else if (level === 'debug' && shouldWrite(level, severityText)) {
      writeEventText(record)
    } else if (status === 'failed' && event !== 'route' && shouldWrite(level, severityText)) {
      writeEventText(record)
    }

    if (reqId) {
      if (!requests.has(reqId)) {
        requests.set(reqId, { ts: msg.ts, events: [], method: null, tool: null })
      }
      const req = requests.get(reqId)
      req.events.push({ event, status, duration, error })

      if (event === 'validate' && msg.payload?.method) {
        req.method = msg.payload.method
      }
      if (event === 'validate' && msg.payload?.method === 'tools/call') {
        req.tool = msg.payload.params?.name
      }

      if (event === 'route') {
        const summarySeverity = requestSeverity(status)
        const total = Date.now() - req.ts
        const parts = req.events.map(e =>
          `${e.event}:${e.duration}ms${e.error ? '!' : ''}`
        ).join(' ')
        const label = req.tool ? `${req.method} ${req.tool}` : req.method || '?'
        const finalStatus = status === 'completed' ? 'completed' : 'failed'
        const summary = {
          timestamp: new Date(msg.ts).toISOString(),
          severityText: summarySeverity,
          severityNumber: SEVERITY[summarySeverity],
          reqId,
          event: 'request',
          status: finalStatus,
          method: req.method,
          tool: req.tool,
          duration: total,
          parts,
          error
        }
        if (shouldWrite(level, summarySeverity)) {
          if (level === 'trace') writeRecord(summary)
          else {
            const suffix = error ? ` ${error}` : ''
            process.stderr.write(`${summarySeverity} ${reqId} ${label} ${finalStatus} ${total}ms [${parts}]${suffix}\n`)
          }
        }
        requests.delete(reqId)
      } else if (status === 'failed') {
        requests.delete(reqId)
      }
    }

    if (auditFile) {
      appendFileSync(auditFile, JSON.stringify(record) + '\n')
    }
  })
}
