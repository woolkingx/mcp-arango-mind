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

function matchesTags(op, tags) {
  if (!tags || tags.length === 0) return true
  return tags.some(tag => op.tags.includes(tag))
}

function matchesKeywords(op, operationId, keywords) {
  const haystack = `${operationId} ${op.summary} ${op.description} ${op.tags.join(' ')}`.toLowerCase()
  return keywords.every(keyword => haystack.includes(keyword.toLowerCase()))
}

function searchKeywords(payload) {
  if (Array.isArray(payload.keywords)) return payload.keywords.filter(keyword => typeof keyword === 'string' && keyword.trim())
  if (typeof payload.query === 'string') return payload.query.split(/\s+/).filter(Boolean)
  return []
}

export function createArangoSurfaceHandlers(arangoApi) {
  function list(payload) {
    const limit = payload.limit ?? 50
    const tags = payload.tags
    const matches = []
    for (const [operationId, op] of arangoApi.operations) {
      if (!matchesTags(op, tags)) continue
      matches.push(operationRecord(op, operationId))
      if (matches.length >= limit) break
    }
    return { operations: matches, total: matches.length, limit }
  }

  function search(payload) {
    const keywords = searchKeywords(payload)
    if (!keywords.length) throw new Error('mcp.arango search requires a non-empty query or keywords')
    const limit = payload.limit ?? 50
    const tags = payload.tags
    const matches = []
    for (const [operationId, op] of arangoApi.operations) {
      if (!matchesTags(op, tags)) continue
      if (!matchesKeywords(op, operationId, keywords)) continue
      matches.push(operationRecord(op, operationId))
      if (matches.length >= limit) break
    }
    return { operations: matches, total: matches.length, limit, keywords }
  }

  function describe(payload) {
    const op = arangoApi.getOperation(payload.target)
    if (!op) throw new Error(`unknown operationId: ${payload.target}`)
    return {
      operationId: payload.target,
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
    return await arangoApi.callOperation(payload.target, payload.params || {})
  }

  return {
    'arangoSurface.list': list,
    'arangoSurface.search': search,
    'arangoSurface.describe': describe,
    'arangoSurface.call': call,
    'arangoSurface.exec': call
  }
}
