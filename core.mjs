// core.mjs — Assembles components, exposes handle(msg) → response

import { createBus } from './bus.mjs'
import { createPool } from './pool.mjs'
import { createLogger } from './log.mjs'
import { createDispatch } from './dispatch.mjs'
import { createProtocol } from './protocol.mjs'

export function createCore(config) {
  const { profile, mcpSchema, openapiSpec, debug, auditFile } = config

  const bus = createBus()
  const pool = createPool(profile)
  createLogger(bus, { auditFile, debug })
  const { getToolList } = createDispatch(bus, pool, openapiSpec)
  const toolList = getToolList()
  createProtocol(bus, mcpSchema, toolList)

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
    pool.close()
  }

  return { handle, close }
}
