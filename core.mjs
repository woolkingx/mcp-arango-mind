// core.mjs — Assembles components, exposes handle(msg) → response

import { createBus } from './bus.mjs'
import { createConnection } from './connection.mjs'
import { createLogger } from './log.mjs'
import { createDispatch } from './dispatch.mjs'
import { createProtocol } from './protocol.mjs'

export function createCore(config) {
  const { profile, mcpSchema, openapiSpec, debug, auditFile } = config

  const bus = createBus()
  const conn = createConnection(profile)
  createLogger(bus, { auditFile, debug })
  const { getToolList, getResourceList, getCategories, getToolHelp } = createDispatch(bus, conn, openapiSpec)
  createProtocol(bus, mcpSchema, {
    toolList: getToolList(),
    resourceList: getResourceList(),
    getCategories,
    getToolHelp
  })

  async function handle(message) {
    try {
      const validated = await bus.send('validate', message)
      const response = await bus.send('route', validated)
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
