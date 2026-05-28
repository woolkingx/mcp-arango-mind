import { createRuntimeSchemaRegistry } from './runtime-schema.mjs'

function operationRecord(op, operationId) {
  return {
    operationId,
    method: op.method,
    path: op.pathTemplate,
    summary: op.summary,
    description: op.description,
    tags: op.tags
  }
}

function intersectsTags(opTags, allowed) {
  if (!Array.isArray(opTags)) return false
  for (const tag of opTags) {
    if (allowed.has(tag)) return true
  }
  return false
}

function buildWhitelist(arangoApi, tags) {
  const allowed = new Set(tags)
  const whitelist = new Map()
  for (const [operationId, op] of arangoApi.operations) {
    if (intersectsTags(op.tags, allowed)) whitelist.set(operationId, op)
  }
  return whitelist
}

function schemaText(op) {
  const parameters = (op.parameters || []).map(param => ({
    name: param.name,
    description: param.description,
    type: param.schema?.type,
    enum: param.schema?.enum
  }))
  return `${JSON.stringify(parameters)} ${JSON.stringify(op.bodySchema || null)}`
}

function matchesKeywords(record, op, keywords) {
  const haystack = `${record.operationId} ${record.summary} ${record.description} ${record.tags.join(' ')} ${schemaText(op)}`.toLowerCase()
  return keywords.every(keyword => haystack.includes(keyword.toLowerCase()))
}

function runtimeSchemaDocuments(payload) {
  const params = payload.params || {}
  const body = params._body
  if (Array.isArray(body)) return body.filter(item => item && typeof item === 'object' && !Array.isArray(item))
  if (body && typeof body === 'object') return [body]
  return []
}

function isRuntimeDocumentBodySchema(schema) {
  if (!schema || typeof schema !== 'object') return false
  if (schema.type === 'object') return true
  if (schema.type === 'array' && schema.items?.type === 'object') return true
  return false
}

function runtimeValidationMode(op, payload) {
  if (!Array.isArray(op.tags) || !op.tags.includes('Documents')) return null
  if (!isRuntimeDocumentBodySchema(op.bodySchema)) return null
  if (typeof payload.params?.collection !== 'string') return null
  if (op.method === 'PATCH') return 'partial'
  if (op.method === 'POST' || op.method === 'PUT') return 'full'
  return null
}

function validateRuntimeSchemaBeforeDispatch(payload, op, runtimeSchemas) {
  const mode = runtimeValidationMode(op, payload)
  if (!mode) return
  const collection = payload.params?.collection
  if (!runtimeSchemas.hasSchema(collection)) return
  const documents = runtimeSchemaDocuments(payload)
  for (const document of documents) {
    const result = runtimeSchemas.validate(collection, document, { mode })
    if (!result.valid) {
      throw new Error(`runtime schema validation failed for ${collection}: ${result.errors.join('; ')}`)
    }
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined))
}

function firstDefined(...values) {
  return values.find(value => value !== undefined)
}

function bodyFrom(payload, ...names) {
  return firstDefined(...names.map(name => payload[name]), payload._body)
}

function unsupportedAction(category, action) {
  throw new Error(`${category} action not migrated in master yet: ${action}. Use mcp.mcp search_tools for the async reference params.`)
}

function assertFieldName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsupported filter field: ${name}`)
  }
}

function filterExpression(fieldRef, op, valueRef) {
  if (op === '$gt') return `${fieldRef} > ${valueRef}`
  if (op === '$gte') return `${fieldRef} >= ${valueRef}`
  if (op === '$lt') return `${fieldRef} < ${valueRef}`
  if (op === '$lte') return `${fieldRef} <= ${valueRef}`
  if (op === '$ne') return `${fieldRef} != ${valueRef}`
  if (op === '$in') return `${fieldRef} IN ${valueRef}`
  throw new Error(`unsupported filter operator: ${op}`)
}

function buildFilterAql(collection, filter = {}, limit = 100) {
  if (!collection) throw new Error('collection find filter requires payload.collection')
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error('collection find filter requires object payload.filter')
  }
  const bindVars = { '@collection': collection, limit }
  const clauses = []
  let i = 0
  for (const [field, value] of Object.entries(filter)) {
    assertFieldName(field)
    const fieldName = `field${i}`
    bindVars[fieldName] = field
    const fieldRef = `doc[@${fieldName}]`
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [op, child] of Object.entries(value)) {
        const valueName = `value${i}`
        bindVars[valueName] = child
        clauses.push(filterExpression(fieldRef, op, `@${valueName}`))
        i += 1
      }
    } else {
      const valueName = `value${i}`
      bindVars[valueName] = value
      clauses.push(`${fieldRef} == @${valueName}`)
      i += 1
    }
  }
  if (!clauses.length) throw new Error('collection find filter requires at least one field')
  return {
    query: `FOR doc IN @@collection FILTER ${clauses.join(' AND ')} LIMIT @limit RETURN doc`,
    bindVars
  }
}

const ACTION_DISPATCH = {
  database: {
    list: { op: 'listDatabases', args: () => ({}) },
    get_active: { op: 'getCurrentDatabase', args: () => ({}) },
    get_focused: { op: 'getCurrentDatabase', args: () => ({}) }
  },
  collection: {
    insert: {
      op: 'createDocument',
      args: payload => compact({ collection: payload.collection, returnNew: payload.returnNew, returnOld: payload.returnOld, waitForSync: payload.waitForSync, _body: bodyFrom(payload, 'document', 'data') })
    },
    insert_with_validation: {
      op: 'createDocument',
      args: payload => compact({ collection: payload.collection, returnNew: payload.returnNew, returnOld: payload.returnOld, waitForSync: payload.waitForSync, _body: bodyFrom(payload, 'document', 'data') })
    },
    bulk_insert: {
      op: 'createDocuments',
      args: payload => compact({ collection: payload.collection, _body: bodyFrom(payload, 'documents') })
    },
    update: {
      op: 'updateDocument',
      args: payload => compact({ collection: payload.collection, key: payload.key, returnNew: payload.returnNew, returnOld: payload.returnOld, waitForSync: payload.waitForSync, _body: bodyFrom(payload, 'update', 'document') })
    },
    remove: {
      op: 'deleteDocument',
      args: payload => compact({ collection: payload.collection, key: payload.key })
    },
    find: {
      run: async ({ payload, arangoApi }) => {
        if (payload.key) {
          return await arangoApi.callOperation('getDocument', compact({ collection: payload.collection, key: payload.key }))
        }
        return await arangoApi.callOperation('createAqlQueryCursor', buildFilterAql(payload.collection, payload.filter, payload.limit))
      }
    },
    list: { op: 'listCollections', args: () => ({}) },
    create: {
      op: 'createCollection',
      args: payload => compact({ name: payload.name || payload.collection, type: payload.type === 'edge' ? 3 : undefined, schema: payload.schema })
    },
    stats: {
      op: 'getCollectionFigures',
      args: payload => compact({ 'collection-name': payload.collection })
    },
    drop: {
      op: 'deleteCollection',
      args: payload => compact({ 'collection-name': payload.collection })
    },
    truncate: {
      op: 'truncateCollection',
      args: payload => compact({ 'collection-name': payload.collection })
    },
    list_indexes: {
      op: 'listIndexes',
      args: payload => compact({ collection: payload.collection })
    },
    create_index: {
      op: 'createIndex',
      args: payload => compact({ collection: payload.collection, _body: compact({ type: payload.type, fields: payload.fields, unique: payload.unique, name: payload.name }) })
    },
    delete_index: {
      op: 'deleteIndex',
      args: payload => compact({ 'index-id': payload.id_or_name || payload.id || payload.name })
    },
    get_schema: {
      run: async ({ payload, runtimeSchemas }) => ({
        collection: payload.schema_name || payload.collection,
        schema: runtimeSchemas.getRuntimeSchema(payload.schema_name || payload.collection)
      })
    },
    validate_document: {
      run: async ({ payload, runtimeSchemas }) => ({
        collection: payload.collection,
        ...runtimeSchemas.validate(payload.collection, bodyFrom(payload, 'document', 'data'))
      })
    }
  },
  view: {
    create: {
      op: 'createView',
      args: payload => compact({ name: payload.name, type: payload.type || 'arangosearch', ...(payload.properties || {}) })
    },
    drop: {
      op: 'deleteView',
      args: payload => compact({ 'view-name': payload.name })
    },
    list: { op: 'listViews', args: () => ({}) },
    get: {
      op: 'getView',
      args: payload => compact({ 'view-name': payload.name })
    },
    update: {
      op: 'updateViewProperties',
      args: payload => compact({ 'view-name': payload.name, ...(payload.properties || {}) })
    },
    search: {
      op: 'createAqlQueryCursor',
      args: payload => compact({ query: payload.query, bindVars: payload.bind_vars || payload.bindVars })
    }
  },
  graph: {
    create: {
      op: 'createGraph',
      args: payload => compact({ name: payload.name, edgeDefinitions: payload.edge_definitions, orphanCollections: payload.orphan_collections })
    },
    list: { op: 'listGraphs', args: () => ({}) },
    add_vertex_collection: {
      op: 'addVertexCollection',
      args: payload => compact({ graph: payload.graph, collection: payload.collection })
    },
    add_edge_definition: {
      op: 'createEdgeDefinition',
      args: payload => compact({ graph: payload.graph, collection: payload.edge_collection, from: payload.from_collections, to: payload.to_collections })
    },
    add_edge: {
      op: 'createEdge',
      args: payload => compact({ graph: payload.graph, collection: payload.collection, _from: payload.from_id, _to: payload.to_id, ...(payload.attributes || {}) })
    }
  },
  admin: {
    aql_query: {
      op: 'createAqlQueryCursor',
      args: payload => compact({ query: payload.query, bindVars: payload.bind_vars || payload.bindVars })
    },
    aql_explain: {
      op: 'explainAqlQuery',
      args: payload => compact({ query: payload.query, bindVars: payload.bind_vars || payload.bindVars, maxPlans: payload.max_plans })
    },
    aql_profile: {
      op: 'createAqlQueryCursor',
      args: payload => compact({ query: payload.query, bindVars: payload.bind_vars || payload.bindVars, profile: 2 })
    }
  }
}

export function createCategoryOwnerHandlers(arangoApi, { name, tags, runtimeSchemas = createRuntimeSchemaRegistry() }) {
  const whitelist = buildWhitelist(arangoApi, tags)
  const handlerPrefix = `category${name[0].toUpperCase()}${name.slice(1)}`

  function list(payload) {
    const limit = payload.limit ?? 100
    const matches = []
    for (const [operationId, op] of whitelist) {
      matches.push(operationRecord(op, operationId))
      if (matches.length >= limit) break
    }
    return { category: name, operations: matches, total: matches.length, limit }
  }

  function search(payload) {
    const keywords = Array.isArray(payload.keywords) ? payload.keywords.filter(keyword => typeof keyword === 'string' && keyword.trim()) : []
    if (!keywords.length) throw new Error(`${name} category search requires non-empty keywords`)
    const limit = payload.limit ?? 100
    const matches = []
    for (const [operationId, op] of whitelist) {
      const record = operationRecord(op, operationId)
      if (!matchesKeywords(record, op, keywords)) continue
      matches.push(record)
      if (matches.length >= limit) break
    }
    return { category: name, operations: matches, total: matches.length, limit, keywords }
  }

  function describe(payload) {
    const op = whitelist.get(payload.target)
    if (!op) throw new Error(`operation outside ${name} category: ${payload.target}`)
    return {
      operationId: payload.target,
      category: name,
      method: op.method,
      path: op.pathTemplate,
      summary: op.summary,
      description: op.description,
      tags: op.tags,
      parameters: op.parameters,
      bodySchema: op.bodySchema,
      bodyContentType: op.bodyContentType,
      responses: op.responses,
      inputSchema: op.inputSchema
    }
  }

  async function call(payload) {
    const op = whitelist.get(payload.target)
    if (!op) {
      throw new Error(`operation outside ${name} category: ${payload.target}`)
    }
    if (name === 'collection') {
      validateRuntimeSchemaBeforeDispatch(payload, op, runtimeSchemas)
    }
    return await arangoApi.callOperation(payload.target, payload.params || {})
  }

  async function dispatch(payload, action) {
    const mapping = ACTION_DISPATCH[name]?.[action]
    if (!mapping) unsupportedAction(name, action)
    if (mapping.run) {
      return await mapping.run({ payload: payload || {}, arangoApi, runtimeSchemas })
    }
    const op = whitelist.get(mapping.op) || arangoApi.getOperation(mapping.op)
    if (!op) throw new Error(`operation outside ${name} category: ${mapping.op}`)
    const params = mapping.args(payload || {})
    if (name === 'collection') {
      validateRuntimeSchemaBeforeDispatch({ params }, op, runtimeSchemas)
    }
    return await arangoApi.callOperation(mapping.op, params)
  }

  return {
    [`${handlerPrefix}.list`]: list,
    [`${handlerPrefix}.search`]: search,
    [`${handlerPrefix}.describe`]: describe,
    [`${handlerPrefix}.call`]: call,
    [`${handlerPrefix}.dispatch`]: dispatch
  }
}
