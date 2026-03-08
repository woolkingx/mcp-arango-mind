// core.mjs — Assembles components, exposes handle(msg) → response

import { createBus } from './bus.mjs'
import { createConnection } from './connection.mjs'
import { createLogger } from './log.mjs'
import { createDispatch } from './dispatch.mjs'
import { createProtocol } from './protocol.mjs'

export function createCore(config) {
  const { profile, mcpSchema, openapiSpec, logLevel, auditFile } = config

  const bus = createBus()
  const conn = createConnection(profile)
  createLogger(bus, { auditFile, logLevel: logLevel || profile.logLevel })
  const { getToolList, getResourceList, getCategories, getToolHelp } = createDispatch(bus, conn, openapiSpec)
  createProtocol(bus, mcpSchema, {
    toolList: getToolList(),
    resourceList: getResourceList(),
    getCategories,
    getToolHelp
  })

  async function handle(message) {
    const reqId = bus.newRequest()
    try {
      const validated = await bus.send('validate', message, reqId)
      const response = await bus.send('route', validated, reqId)
      return response
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: -32603, message: err.message }
      }
    }
  }

  function close() {
    conn.close()
  }

  return { handle, close }
}
