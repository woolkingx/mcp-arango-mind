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

export function createCategoryOwnerHandlers(arangoApi, { name, tags }) {
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
    if (!whitelist.has(payload.target)) {
      throw new Error(`operation outside ${name} category: ${payload.target}`)
    }
    return await arangoApi.callOperation(payload.target, payload.params || {})
  }

  return {
    [`${handlerPrefix}.list`]: list,
    [`${handlerPrefix}.search`]: search,
    [`${handlerPrefix}.describe`]: describe,
    [`${handlerPrefix}.call`]: call
  }
}
