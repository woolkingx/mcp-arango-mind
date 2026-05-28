import { Loader, ObjectTree } from './lib/schema2object.mjs'
import { json2md } from './lib/json2md.mjs'

function stripToolCatalog(schema) {
  const { $defs: _defs, ...rest } = schema
  return rest
}

function formatOutput(data, format) {
  if (format === 'md') return json2md(data)
  return JSON.stringify(data, null, 2)
}

function toolAnnotations(actions) {
  return {
    readOnlyHint: actions.every(action => action.readOnly === true),
    destructiveHint: actions.some(action => action.readOnly !== true),
    idempotentHint: actions.every(action => action.readOnly === true),
    openWorldHint: actions.some(action => action.readOnly !== true)
  }
}

function catalogRefs(toolsSchema) {
  return Object.values(toolsSchema.$defs || {}).map(def => def.$ref).filter(Boolean)
}

function toolNameFromSchema(schema, ref) {
  const name = schema.$defs?.tool?.const
  if (typeof name !== 'string' || !name) {
    throw new Error(`tool schema missing $defs.tool.const: ${ref}`)
  }
  return name
}

function actionSchemasFrom(schema, ref) {
  const actions = schema.$defs?.actions?.properties
  if (!actions || typeof actions !== 'object') {
    throw new Error(`tool schema missing $defs.actions.properties: ${ref}`)
  }
  return actions
}

function availableActionSchemas(actions) {
  return Object.fromEntries(Object.entries(actions).filter(([, schema]) => schema.deprecated !== true))
}

function assertActionSchemaMatchesCatalog(schema, actions, name, ref) {
  const declaredActions = schema.properties?.action?.enum
  if (!Array.isArray(declaredActions) || declaredActions.length === 0) {
    throw new Error(`tool schema must declare action enum: ${ref}`)
  }
  const catalogActions = Object.keys(actions)
  for (const actionName of catalogActions) {
    if (!declaredActions.includes(actionName)) {
      throw new Error(`tool action missing from schema enum: ${name}.${actionName}`)
    }
  }
  for (const actionName of declaredActions) {
    if (!Object.prototype.hasOwnProperty.call(actions, actionName)) {
      throw new Error(`schema action missing $defs.actions entry: ${name}.${actionName}`)
    }
  }
}

function defaultHandlerName(toolName) {
  if (toolName === 'mcp.mcp') return 'mcpMeta.dispatch'
  if (toolName === 'mcp.help') return 'mcpHelp.dispatch'
  if (toolName === 'mcp.arango') return 'arangoSurface.dispatch'
  if (toolName === 'mcp.tool.template') return 'templateOwner.dispatch'
  if (toolName === 'mcp.tool.atlas') return 'atlasOwner.dispatch'
  if (toolName.startsWith('mcp.tool.')) {
    const category = toolName.slice('mcp.tool.'.length)
    return `category${category[0].toUpperCase()}${category.slice(1)}.dispatch`
  }
  throw new Error(`no default handler for tool: ${toolName}`)
}

function firstPayloadExample(actionSchema) {
  const event = Array.isArray(actionSchema.examples) ? actionSchema.examples[0] : null
  return event && typeof event === 'object' && event.payload && typeof event.payload === 'object'
    ? event.payload
    : {}
}

function actionLine(toolName, actionName, actionSchema) {
  const summary = actionSchema.description || actionName
  const payload = JSON.stringify(firstPayloadExample(actionSchema))
  return `${actionName} - ${summary} ${toolName}(action=${actionName}, payload=${payload})`
}

function toolDescription(toolName, actionSchemas) {
  const lines = Object.entries(actionSchemas).map(([actionName, actionSchema]) => actionLine(toolName, actionName, actionSchema))
  return lines.join('\n')
}

function projectInputSchema(schema, actionSchemas) {
  const projected = stripToolCatalog(structuredClone(schema))
  if (projected.properties?.action) {
    projected.properties.action.enum = Object.keys(actionSchemas)
  }
  return projected
}

export function createTools(toolsSchema, arangoApi, resolver, customHandlers = {}) {
  const loader = new Loader(toolsSchema, resolver, 'tools.schema.json')
  const refs = catalogRefs(toolsSchema)
  const tools = new Map()

  for (const ref of refs) {
    const { node, loader: toolLoader } = loader.resolve(ref, 'tools.schema.json')
    const actionSchemas = actionSchemasFrom(node, ref)
    const availableActions = availableActionSchemas(actionSchemas)
    const name = toolNameFromSchema(node, ref)
    const meta = {
      name,
      title: node.$defs?.tool?.title || node.title,
      description: toolDescription(name, availableActions),
      actions: availableActions
    }
    assertActionSchemaMatchesCatalog(node, actionSchemas, name, ref)
    const operations = new Map()
    const handlers = new Map()
    const handlerName = defaultHandlerName(meta.name)
    const handler = customHandlers[handlerName]
    if (!handler) throw new Error(`tool action references unknown handler: ${meta.name} -> ${handlerName}`)
    for (const actionName of Object.keys(meta.actions)) {
      handlers.set(actionName, handler)
    }
    tools.set(meta.name, { schema: node, loader: toolLoader, meta, operations, handlers, actionSchemas, availableActions })
  }

  const toolList = [...tools.values()].map(({ schema, meta, availableActions }) => ({
    name: meta.name,
    title: meta.title,
    description: meta.description,
    inputSchema: projectInputSchema(schema, availableActions),
    annotations: toolAnnotations(Object.values(meta.actions))
  }))

  async function callTool(name, args = {}) {
    const tool = tools.get(name)
    if (!tool) return null
    const tree = new ObjectTree(args, projectInputSchema(tool.schema, tool.availableActions), tool.loader)
    const input = tree.$withDefaults().$toDict()
    const action = tool.meta.actions[input.action]
    if (!action) throw new Error(`unknown tool action: ${name}.${input.action}`)
    const payload = input.payload || {}
    let data
    const handler = tool.handlers.get(input.action)
    if (handler) {
      data = await handler(payload, input.action, action)
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

  function helpFor(target, actionName) {
    const tool = tools.get(target)
    if (!tool) throw new Error(`unknown help target: ${target}`)
    if (!actionName) {
      return {
        target,
        title: tool.meta.title,
        actions: Object.entries(tool.availableActions).map(([name, schema]) => ({
          action: name,
          description: schema.description,
          payloadExample: firstPayloadExample(schema)
        }))
      }
    }
    const actionSchema = tool.actionSchemas[actionName]
    if (!actionSchema) throw new Error(`unknown help action: ${target}.${actionName}`)
    const event = Array.isArray(actionSchema.examples) ? actionSchema.examples[0] : { target, action: actionName, payload: {} }
    if (actionSchema.deprecated === true) {
      return {
        target,
        action: actionName,
        available: false,
        description: actionSchema.description,
        event,
        reason: actionSchema.deprecationMessage || 'action is not migrated in master yet'
      }
    }
    return {
      target,
      action: actionName,
      available: true,
      description: actionSchema.description,
      event,
      payloadSchema: tool.schema.$defs?.payloads?.[actionName] || actionSchema.properties?.payload,
      schema: actionSchema
    }
  }

  return { toolList, callTool, helpFor }
}
