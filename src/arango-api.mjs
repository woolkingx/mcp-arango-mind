import { ObjectTree } from './lib/schema2object.mjs'

const METHOD_VERBS = ['get', 'post', 'put', 'delete', 'patch', 'head']

function pickBodyContent(requestBody) {
  const content = requestBody?.content
  if (!content || typeof content !== 'object') return null
  const contentType = content['application/json'] ? 'application/json' : Object.keys(content)[0]
  if (!contentType) return null
  return { contentType, schema: content[contentType]?.schema || {} }
}

function buildInputSchema(op) {
  const properties = {}
  const required = []

  for (const p of op.parameters || []) {
    properties[p.name] = { ...p.schema, description: p.description?.trim() }
    if (p.required) required.push(p.name)
  }

  if (op.bodySchema) {
    if (op.bodySchema.properties) {
      for (const [key, schema] of Object.entries(op.bodySchema.properties)) {
        properties[key] = schema
      }
      if (op.bodySchema.required) required.push(...op.bodySchema.required)
    } else {
      properties._body = op.bodySchema
      required.push('_body')
    }
  }

  const schema = { type: 'object', additionalProperties: false, properties }
  if (required.length) schema.required = required
  return schema
}

function withoutDefaults(value) {
  if (Array.isArray(value)) return value.map(item => withoutDefaults(item))
  if (!value || typeof value !== 'object') return value
  const copy = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'default') continue
    copy[key] = withoutDefaults(child)
  }
  return copy
}

function buildPath(template, pathParams) {
  let path = template
  for (const [name, value] of Object.entries(pathParams)) {
    const encoded = String(value).split('/').map(part => encodeURIComponent(part)).join('/')
    path = path.replace(`{${name}}`, encoded)
  }
  return path
}

function buildQuery(queryParams) {
  const entries = Object.entries(queryParams).filter(([, value]) => value !== undefined)
  if (!entries.length) return ''
  return '?' + entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
}

function buildOperations(openapiSpec) {
  const operations = new Map()

  for (const [pathTemplate, methods] of Object.entries(openapiSpec.paths || {})) {
    for (const verb of METHOD_VERBS) {
      const op = methods[verb]
      if (!op?.operationId) continue

      let httpPath = pathTemplate
      const hashIdx = httpPath.indexOf('#')
      if (hashIdx !== -1) httpPath = httpPath.slice(0, hashIdx)

      const pathParams = []
      const queryParams = []
      const headerParams = []
      const allParams = []

      for (const param of op.parameters || []) {
        allParams.push(param)
        if (param.in === 'path') pathParams.push(param)
        else if (param.in === 'query') queryParams.push(param)
        else if (param.in === 'header') headerParams.push(param)
      }

      const bodyContent = pickBodyContent(op.requestBody)
      const bodySchema = bodyContent?.schema || null
      const entry = {
        method: verb.toUpperCase(),
        pathTemplate: httpPath,
        parameters: allParams,
        pathParams,
        queryParams,
        headerParams,
        bodySchema,
        bodyContentType: bodyContent?.contentType || null,
        summary: op.summary || '',
        description: op.description || '',
        tags: op.tags || [],
        responses: op.responses || {}
      }
      entry.inputSchema = buildInputSchema(entry)
      entry.validationSchema = withoutDefaults(entry.inputSchema)
      operations.set(op.operationId, entry)
    }
  }

  return operations
}

export function createArangoApi(_bus, conn, openapiSpec) {
  const operations = buildOperations(openapiSpec)

  function getOperation(name) {
    return operations.get(name) || null
  }

  async function callOperation(name, args = {}) {
    const op = operations.get(name)
    if (!op) throw new Error(`unknown operation: ${name}`)

    const input = { ...args }
    if (input['database-name'] === undefined && op.pathParams.some(p => p.name === 'database-name')) {
      input['database-name'] = conn.getDatabase()
    }

    const tree = new ObjectTree(input, op.validationSchema)
    const pathValues = {}
    for (const param of op.pathParams) {
      const value = tree[param.name]
      if (value !== undefined) pathValues[param.name] = value
    }

    const queryValues = {}
    for (const param of op.queryParams) {
      const value = tree[param.name]
      if (value !== undefined) queryValues[param.name] = value
    }

    const headers = {}
    for (const param of op.headerParams) {
      const value = tree[param.name]
      if (value !== undefined) headers[param.name] = String(value)
    }

    let body = undefined
    if (op.bodySchema) {
      if (input._body !== undefined) {
        body = input._body
      } else if (op.bodySchema.properties) {
        body = {}
        for (const key of Object.keys(op.bodySchema.properties)) {
          const value = tree[key]
          if (value !== undefined) body[key] = value
        }
        if (!Object.keys(body).length) body = undefined
      }
    }

    if (body !== undefined && op.bodyContentType && !headers['content-type']) {
      headers['content-type'] = op.bodyContentType
    }

    const path = buildPath(op.pathTemplate, pathValues) + buildQuery(queryValues)
    const response = await conn.request(op.method, path, { headers, body })
    return response.data
  }

  return { operations, getOperation, callOperation }
}
