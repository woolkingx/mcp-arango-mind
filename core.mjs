// core.mjs — Assembles components, exposes handle(msg) → response

import { createBus } from './bus.mjs'
import { createConnection } from './connection.mjs'
import { createLogger } from './log.mjs'
import { createDispatch } from './dispatch.mjs'
import { createProtocol } from './protocol.mjs'
import { saveEnv } from './env.mjs'
import { ObjectTree } from './lib/schema2object.mjs'

export function createCore(config) {
  const { profile, mcpSchema, openapiSpec, connSchema, logLevel, auditFile } = config

  const bus = createBus()
  const conn = createConnection(profile)
  createLogger(bus, { auditFile, logLevel: logLevel || profile.logLevel })

  // Connection localHandlers — bound to conn, passed to dispatch
  // Action names match ConnectionTools.items[0].inputSchema.properties.action.enum in arango-connection.json
  // Each action schema read from arango-connection.json ConnectionTools.actions[]
  const connActions = connSchema.definitions.ConnectionTools.actions
  const schemaFor = (name) => connActions.find(a => a.name === name).inputSchema
  const localHandlers = {
    getConfig: () => ({ database: conn.getDatabase(), url: conn.getActiveHostUrl() }),
    setDatabase: (args) => {
      // ObjectTree throws on construction if required: ['database'] not satisfied
      const tree = new ObjectTree(args, schemaFor('setDatabase'))
      conn.setDatabase(tree.database)
      saveEnv('ARANGO_DB', tree.database)
      return { database: conn.getDatabase(), persisted: true }
    },
    setAuth: (args) => {
      const tree = new ObjectTree(args, schemaFor('setAuth'))
      const auth = tree.token
        ? { token: tree.token }
        : { username: tree.username || 'root', password: tree.password || '' }
      conn.setAuth(auth)
      if (tree.token) saveEnv('ARANGO_TOKEN', tree.token)
      else { saveEnv('ARANGO_USERNAME', auth.username); saveEnv('ARANGO_PASSWORD', auth.password) }
      return { auth: tree.token ? 'bearer' : 'basic', persisted: true }
    }
  }

  const { getToolList, dispatchCategory, getResourceList, getCategories, getToolHelp } = createDispatch(bus, conn, openapiSpec, connSchema, localHandlers)
  createProtocol(bus, mcpSchema, {
    toolList: getToolList(),
    dispatchCategory,
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
