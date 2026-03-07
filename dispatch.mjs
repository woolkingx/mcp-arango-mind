// dispatch.mjs — OpenAPI spec → HTTP dispatch engine

const DB_PREFIX = '/_db/{database-name}'
const METHOD_VERBS = ['get', 'post', 'put', 'delete', 'patch']

// Build MCP inputSchema from OpenAPI operation parameters + requestBody
function buildInputSchema(op) {
  const properties = {}
  const required = []

  for (const p of op.parameters) {
    properties[p.name] = { ...p.schema, description: p.description?.trim() }
    if (p.required) required.push(p.name)
  }

  if (op.bodySchema) {
    // Merge body schema properties directly into top-level
    if (op.bodySchema.properties) {
      for (const [k, v] of Object.entries(op.bodySchema.properties)) {
        properties[k] = v
      }
      if (op.bodySchema.required) {
        required.push(...op.bodySchema.required)
      }
    } else {
      // Non-object body (array, etc.) — use special `_body` key
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

export function createDispatch(bus, pool, openapiSpec) {
  const operations = new Map()

  // --- Build operation lookup table ---
  for (const [pathTemplate, methods] of Object.entries(openapiSpec.paths)) {
    for (const verb of METHOD_VERBS) {
      const op = methods[verb]
      if (!op) continue

      const name = op.operationId
      if (!name) continue

      // Strip /_db/{database-name} prefix — pool.fetch prepends baseUrl which includes it
      let httpPath = pathTemplate
      if (httpPath.startsWith(DB_PREFIX)) {
        httpPath = httpPath.slice(DB_PREFIX.length)
      }

      // Strip #fragment from path (OpenAPI uses it for variant disambiguation)
      const hashIdx = httpPath.indexOf('#')
      if (hashIdx !== -1) httpPath = httpPath.slice(0, hashIdx)

      // Separate parameters by `in` field, skip database-name (handled by pool)
      const pathParams = []
      const queryParams = []
      const headerParams = []
      const allParams = []

      for (const p of op.parameters || []) {
        if (p.name === 'database-name') continue
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

      operations.set(name, {
        method: verb.toUpperCase(),
        pathTemplate: httpPath,
        parameters: allParams,
        pathParams,
        queryParams,
        headerParams,
        bodySchema,
        summary: op.summary || '',
        description: op.description || ''
      })
    }
  }

  // --- getToolList: MCP Tool objects for tools/list ---
  function getToolList() {
    const tools = []
    for (const [name, op] of operations) {
      tools.push({
        name,
        description: (op.summary || op.description || name).trim(),
        inputSchema: buildInputSchema(op)
      })
    }
    return tools
  }

  // --- Bus handler: route tool call → HTTP request ---
  bus.handle('dispatch', async ({ name, arguments: args }) => {
    const op = operations.get(name)
    if (!op) throw new Error(`unknown operation: ${name}`)

    const pathValues = {}
    const queryValues = {}
    const headers = {}
    const bodyParamNames = new Set()

    // Collect known parameter names for body detection
    for (const p of op.parameters) bodyParamNames.add(p.name)

    // Decompose args by parameter type
    for (const p of op.pathParams) {
      if (args[p.name] !== undefined) pathValues[p.name] = args[p.name]
    }
    for (const p of op.queryParams) {
      if (args[p.name] !== undefined) queryValues[p.name] = args[p.name]
    }
    for (const p of op.headerParams) {
      if (args[p.name] !== undefined) headers[p.name] = String(args[p.name])
    }

    // Build body: remaining args that aren't params, or explicit _body
    let body = undefined
    if (op.bodySchema) {
      if (args._body !== undefined) {
        body = args._body
      } else if (op.bodySchema.properties) {
        // Collect properties that match body schema (not in params)
        body = {}
        for (const key of Object.keys(op.bodySchema.properties)) {
          if (args[key] !== undefined) body[key] = args[key]
        }
        // Also include any args not matching known params or body schema props
        // (handles additionalProperties)
        for (const [key, val] of Object.entries(args)) {
          if (!bodyParamNames.has(key) && !(key in body)) {
            body[key] = val
          }
        }
        if (!Object.keys(body).length) body = undefined
      }
    }

    // Assemble URL
    const path = buildPath(op.pathTemplate, pathValues) + buildQuery(queryValues)

    const result = await pool.fetch(op.method, path, { headers, body })
    return result
  })

  return { getToolList, operations }
}
