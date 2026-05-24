import { Loader, ObjectTree } from './lib/schema2object.mjs'
import { json2md } from './lib/json2md.mjs'

function stripToolExtensions(schema) {
  const { ['x-tool']: _tool, ...rest } = schema
  return rest
}

function formatOutput(data, format) {
  if (format === 'md') return json2md(data)
  return JSON.stringify(data, null, 2)
}

function toolAnnotations(actions) {
  return {
    readOnlyHint: actions.every(action => action.effect === 'read'),
    destructiveHint: actions.some(action => action.effect !== 'read'),
    idempotentHint: actions.every(action => !!action.idempotent),
    openWorldHint: actions.some(action => !!action.openWorld)
  }
}

function assertActionSchemaMatchesMeta(schema, meta, ref) {
  const declaredActions = schema.properties?.action?.enum
  if (!Array.isArray(declaredActions) || declaredActions.length === 0) {
    throw new Error(`tool schema must declare action enum: ${ref}`)
  }
  const metaActions = Object.keys(meta.actions)
  for (const actionName of metaActions) {
    if (!declaredActions.includes(actionName)) {
      throw new Error(`tool action missing from schema enum: ${meta.name}.${actionName}`)
    }
  }
  for (const actionName of declaredActions) {
    if (!Object.prototype.hasOwnProperty.call(meta.actions, actionName)) {
      throw new Error(`schema action missing x-tool.actions metadata: ${meta.name}.${actionName}`)
    }
  }
}

export function createTools(toolsSchema, arangoApi, resolver, customHandlers = {}) {
  const loader = new Loader(toolsSchema, resolver, 'tools.schema.json')
  const refs = toolsSchema['x-tools'] || []
  const tools = new Map()

  for (const item of refs) {
    const ref = item.$ref
    if (!ref) throw new Error('tools.schema.json x-tools entry missing $ref')
    const { node, loader: toolLoader } = loader.resolve(ref, 'tools.schema.json')
    const meta = node['x-tool']
    if (!meta?.name) throw new Error(`tool schema missing x-tool.name: ${ref}`)
    if (!meta.actions || typeof meta.actions !== 'object') throw new Error(`tool schema missing x-tool.actions: ${ref}`)
    assertActionSchemaMatchesMeta(node, meta, ref)
    const operations = new Map()
    const handlers = new Map()
    for (const [actionName, action] of Object.entries(meta.actions)) {
      if (action?.operationId) {
        const operation = arangoApi.getOperation(action.operationId)
        if (!operation) throw new Error(`tool action references unknown operationId: ${meta.name}.${actionName} -> ${action.operationId}`)
        operations.set(actionName, operation)
        continue
      }
      if (action?.handler) {
        const handler = customHandlers[action.handler]
        if (!handler) throw new Error(`tool action references unknown handler: ${meta.name}.${actionName} -> ${action.handler}`)
        handlers.set(actionName, handler)
        continue
      }
      throw new Error(`tool action missing operationId or handler: ${meta.name}.${actionName}`)
    }
    tools.set(meta.name, { schema: node, loader: toolLoader, meta, operations, handlers })
  }

  const toolList = [...tools.values()].map(({ schema, meta }) => ({
    name: meta.name,
    title: meta.title,
    description: meta.description,
    inputSchema: stripToolExtensions(schema),
    annotations: toolAnnotations(Object.values(meta.actions))
  }))

  async function callTool(name, args = {}) {
    const tool = tools.get(name)
    if (!tool) return null
    const tree = new ObjectTree(args, stripToolExtensions(tool.schema), tool.loader)
    const input = tree.$withDefaults().$toDict()
    const action = tool.meta.actions[input.action]
    if (!action) throw new Error(`unknown tool action: ${name}.${input.action}`)
    const payload = input.payload || {}
    let data
    const handler = tool.handlers.get(input.action)
    if (handler) {
      data = await handler(payload)
    } else {
      const operation = tool.operations.get(input.action)
      if (!operation) throw new Error(`tool action has no resolved operation: ${name}.${input.action}`)
      const operationArgs = {}
      for (const key of Object.keys(operation.inputSchema.properties || {})) {
        if (payload[key] !== undefined) operationArgs[key] = payload[key]
      }
      data = await arangoApi.callOperation(action.operationId, operationArgs)
    }
    return {
      content: [{ type: 'text', text: formatOutput(data, payload.format) }],
      structuredContent: data,
      isError: false
    }
  }

  return { toolList, callTool }
}
