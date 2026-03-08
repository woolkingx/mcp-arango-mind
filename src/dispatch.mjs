// dispatch.mjs — OpenAPI spec → HTTP dispatch engine
import { ObjectTree } from './lib/schema2object.mjs'

const METHOD_VERBS = ['get', 'post', 'put', 'delete', 'patch']

// Build merged inputSchema from OpenAPI operation parameters + requestBody
// Returns raw JSON Schema object — ObjectTree uses it as class definition at tools/call time
function buildInputSchema(op) {
  const properties = {}
  const required = []

  for (const p of op.parameters) {
    properties[p.name] = { ...p.schema, description: p.description?.trim() }
    if (p.required) required.push(p.name)
  }

  if (op.bodySchema) {
    if (op.bodySchema.properties) {
      for (const [k, v] of Object.entries(op.bodySchema.properties)) {
        properties[k] = v
      }
      if (op.bodySchema.required) {
        required.push(...op.bodySchema.required)
      }
    } else {
      properties._body = op.bodySchema
      required.push('_body')
    }
  }

  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

// Substitute {param} placeholders in path template
function buildPath(template, pathParams) {
  let path = template
  for (const [name, value] of Object.entries(pathParams)) {
    path = path.replace(`{${name}}`, encodeURIComponent(value))
  }
  return path
}

// Build URL query string from params object
function buildQuery(queryParams) {
  const entries = Object.entries(queryParams).filter(([, v]) => v !== undefined)
  if (!entries.length) return ''
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

export function createDispatch(bus, conn, openapiSpec, connSchema, localHandlers = {}) {
  const operations = new Map()

  // --- Register ConnectionTools from arango-connection.json as local operations ---
  // Each action has its own name, summary, inputSchema (with required) — read raw from schema
  if (connSchema) {
    const ct = connSchema.definitions?.ConnectionTools
    if (ct) {
      for (const action of ct.actions || []) {
        operations.set(action.name, {
          handler: 'local',
          tags: [ct.categoryName],
          summary: action.summary,
          description: action.summary,
          parameters: [],
          pathParams: [],
          queryParams: [],
          headerParams: [],
          bodySchema: null,
          inputSchema: action.inputSchema
        })
      }
    }
  }

  // --- Build operation lookup table from OpenAPI spec ---
  for (const [pathTemplate, methods] of Object.entries(openapiSpec.paths)) {
    for (const verb of METHOD_VERBS) {
      const op = methods[verb]
      if (!op) continue

      const name = op.operationId
      if (!name) continue

      // Keep full path including /_db/{database-name} — connection applies default
      let httpPath = pathTemplate

      // Strip #fragment from path (OpenAPI uses it for variant disambiguation)
      const hashIdx = httpPath.indexOf('#')
      if (hashIdx !== -1) httpPath = httpPath.slice(0, hashIdx)

      // Separate parameters by `in` field
      const pathParams = []
      const queryParams = []
      const headerParams = []
      const allParams = []

      for (const p of op.parameters || []) {
        allParams.push(p)
        if (p.in === 'path') pathParams.push(p)
        else if (p.in === 'query') queryParams.push(p)
        else if (p.in === 'header') headerParams.push(p)
      }

      // Extract requestBody schema
      let bodySchema = null
      const bodyContent = op.requestBody?.content?.['application/json']
      if (bodyContent?.schema) {
        bodySchema = bodyContent.schema
      }

      const entry = {
        method: verb.toUpperCase(),
        pathTemplate: httpPath,
        parameters: allParams,
        pathParams,
        queryParams,
        headerParams,
        bodySchema,
        summary: op.summary || '',
        description: op.description || '',
        tags: op.tags || [],
        responses: op.responses || {},
      }
      entry.inputSchema = buildInputSchema(entry)
      operations.set(name, entry)
    }
  }

  // --- Build category index once ---
  const categoryIndex = new Map()
  for (const [name, op] of operations) {
    const tag = op.tags[0] || 'Other'
    if (!categoryIndex.has(tag)) categoryIndex.set(tag, [])
    categoryIndex.get(tag).push(name)
  }

  // --- Category-level tool list: 22 categories, each with action enum ---
  function getToolList() {
    const tools = []
    for (const [tag, names] of categoryIndex) {
      const summaries = names.map(n => `${n}: ${operations.get(n).summary}`)
      tools.push({
        name: tag,
        description: `${names.length} tools: ${summaries.join(', ')}`,
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: names,
              description: 'Action to execute. Omit to list available actions.'
            }
          }
        }
      })
    }
    return tools
  }

  // --- Category dispatch: action → real operation, no action → list ---
  function dispatchCategory(categoryName, action, args) {
    const names = categoryIndex.get(categoryName)
    if (!names) return null
    if (!action) {
      return { list: names.map(n => ({ name: n, summary: operations.get(n).summary })) }
    }
    if (!names.includes(action)) return { error: `Unknown action: ${action}. Available: ${names.join(', ')}` }
    return { action, forward: true }
  }

  // --- Resources: tool help as MCP resources ---
  function getResourceList() {
    const resources = []
    // Category overview
    resources.push({
      uri: 'tool://categories',
      name: 'Tool Categories',
      description: 'All tools grouped by API domain',
      mimeType: 'application/json'
    })
    // Per-tool help
    for (const [name, op] of operations) {
      const tag = op.tags[0] || 'Other'
      resources.push({
        uri: `tool://help/${name}`,
        name: `${name}`,
        description: `[${tag}] ${op.summary || name}`,
        mimeType: 'application/json'
      })
    }
    return resources
  }

  function getCategories() {
    const cats = {}
    for (const [name, op] of operations) {
      const tag = op.tags[0] || 'Other'
      if (!cats[tag]) cats[tag] = []
      cats[tag].push({ name, method: op.method, path: op.pathTemplate, summary: op.summary })
    }
    return cats
  }

  function getToolHelp(toolName) {
    const op = operations.get(toolName)
    if (!op) return null
    const help = {
      name: toolName,
      tag: op.tags[0] || 'Other',
      summary: op.summary,
      description: op.description,
      http: { method: op.method, path: op.pathTemplate },
      inputSchema: op.handler === 'local' ? op.inputSchema : buildInputSchema(op),
      parameters: op.parameters.map(p => ({
        name: p.name, in: p.in, required: !!p.required,
        type: p.schema?.type, description: p.description?.trim()
      })),
    }
    if (op.bodySchema) {
      help.requestBody = op.bodySchema
    }
    for (const status of ['200', '201', '202']) {
      const schema = op.responses[status]?.content?.['application/json']?.schema
      if (schema) { help.responseSchema = schema; break }
    }
    return help
  }

  // --- Bus handler: route tool call → HTTP or local handler ---
  bus.handle('dispatch', async ({ name, arguments: args }) => {
    const op = operations.get(name)
    if (!op) throw new Error(`unknown operation: ${name}`)

    // Local handler: handler: 'local' → localHandlers[name](args)
    if (op.handler === 'local') {
      const fn = localHandlers[name]
      if (!fn) throw new Error(`no local handler for: ${name}`)
      return { status: 200, data: fn(args) }
    }

    // Inject database-name default from connection state before validation
    const input = { ...args }
    if (input['database-name'] === undefined && op.pathParams.some(p => p.name === 'database-name')) {
      input['database-name'] = conn.getDatabase()
    }

    // ObjectTree as object class — schema IS the class, tree IS the instance
    // Property getters enforce schema constraints on access (type, enum, format)
    const tree = new ObjectTree(input, op.inputSchema)

    // Access via property getters — schema-driven, not raw dict lookup
    const pathValues = {}
    for (const p of op.pathParams) {
      const v = tree[p.name]
      if (v !== undefined) pathValues[p.name] = v
    }

    const queryValues = {}
    for (const p of op.queryParams) {
      const v = tree[p.name]
      if (v !== undefined) queryValues[p.name] = v
    }

    const headers = {}
    for (const p of op.headerParams) {
      const v = tree[p.name]
      if (v !== undefined) headers[p.name] = String(v)
    }

    // Body: schema-defined properties via tree, additionalProperties from raw input
    const paramNames = new Set(op.parameters.map(p => p.name))
    let body = undefined
    if (op.bodySchema) {
      if (input._body !== undefined) {
        body = input._body
      } else if (op.bodySchema.properties) {
        body = {}
        for (const key of Object.keys(op.bodySchema.properties)) {
          const v = tree[key]
          if (v !== undefined) body[key] = v
        }
        // additionalProperties: keys not in params and not already in body
        for (const [key, val] of Object.entries(input)) {
          if (!paramNames.has(key) && !(key in body)) body[key] = val
        }
        if (!Object.keys(body).length) body = undefined
      }
    }

    const path = buildPath(op.pathTemplate, pathValues) + buildQuery(queryValues)
    return await conn.request(op.method, path, { headers, body })
  })

  return { getToolList, dispatchCategory, getResourceList, getCategories, getToolHelp, operations }
}
