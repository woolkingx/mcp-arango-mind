// core.mjs — Assembles components, exposes handle(msg) → response

import { createBus } from './bus.mjs'
import { createConnection } from './connection.mjs'
import { createLogger } from './log.mjs'
import { createProtocol } from './protocol.mjs'
import { createMcp } from './mcp.mjs'
import { createArangoApi } from './arango-api.mjs'
import { createTools } from './tools.mjs'
import { createArangoSurfaceHandlers } from './arango-surface.mjs'
import { createTemplateOwnerHandlers } from './template-owner.mjs'
import { createCategoryOwnerHandlers } from './tool-category-owner.mjs'
import { createMcpMetaHandlers } from './mcp-meta.mjs'
import { createAtlasOwnerHandlers } from './atlas-owner.mjs'

const CATEGORY_DEFS = [
  { name: 'database',   tags: ['Databases'] },
  { name: 'collection', tags: ['Collections', 'Documents', 'Indexes'] },
  { name: 'view',       tags: ['Views', 'Analyzers'] },
  { name: 'graph',      tags: ['Graphs'] },
  { name: 'admin',      tags: ['Administration', 'Queries', 'Monitoring', 'Tasks'] }
]

export function createCore(config) {
  const { profile, mcpSchema, toolsSchema, arangoSchema, logLevel, auditFile, toolsResolver, templatesDir } = config

  const bus = createBus()
  const conn = createConnection(profile)
  createLogger(bus, { auditFile, logLevel: logLevel || profile.logLevel })

  const mcp = createMcp(mcpSchema)
  const arangoApi = createArangoApi(bus, conn, arangoSchema)
  let toolsHandle = null
  const customHandlers = {
    ...createArangoSurfaceHandlers(arangoApi),
    ...createTemplateOwnerHandlers(arangoApi, { templatesDir }),
    ...createAtlasOwnerHandlers(arangoApi),
    ...createMcpMetaHandlers(() => toolsHandle)
  }
  for (const def of CATEGORY_DEFS) {
    Object.assign(customHandlers, createCategoryOwnerHandlers(arangoApi, def))
  }
  const tools = createTools(toolsSchema, arangoApi, toolsResolver, customHandlers)
  toolsHandle = tools
  createProtocol(bus, mcp, tools)

  async function handle(message) {
    const reqId = bus.newRequest()
    try {
      const validated = await bus.send('validate', message, reqId)
      const response = await bus.send('route', validated, reqId)
      return response
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: err.code ? err.id : message?.id ?? null,
        error: { code: err.code ?? -32603, message: err.message }
      }
    }
  }

  function close() {
    conn.close()
  }

  return { handle, close }
}
