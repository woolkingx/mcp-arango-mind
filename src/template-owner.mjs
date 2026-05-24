import {
  loadCatalog,
  upsertTemplate,
  removeTemplate,
  buildBindVars
} from './template-catalog.mjs'

const META_TARGETS = new Set(['meta.create', 'meta.update', 'meta.remove', 'meta.validate'])

function matchesKeywords(entry, keywords) {
  const text = `${entry.id} ${entry.description}`.toLowerCase()
  return keywords.every(keyword => text.includes(keyword.toLowerCase()))
}

function toRecord(entry) {
  return {
    id: entry.id,
    category: entry.category,
    name: entry.name,
    description: entry.description,
    params: entry.params
  }
}

function parseId(target) {
  const dot = target.indexOf('.')
  if (dot <= 0 || dot === target.length - 1) {
    throw new Error(`invalid template id: ${target}`)
  }
  return { category: target.slice(0, dot), name: target.slice(dot + 1) }
}

function metaCreate(templatesDir, args) {
  if (!args || !args.category || !args.name || !args.query) {
    throw new Error('meta.create requires args.category, args.name, args.query')
  }
  upsertTemplate(templatesDir, {
    category: args.category,
    name: args.name,
    template: {
      query: args.query,
      description: args.description || '',
      params: args.paramsSchema || {}
    }
  }, { mode: 'create' })
  return { ok: true, id: `${args.category}.${args.name}` }
}

function metaUpdate(templatesDir, args) {
  if (!args || !args.category || !args.name) {
    throw new Error('meta.update requires args.category and args.name')
  }
  const patch = {}
  if (args.query !== undefined) patch.query = args.query
  if (args.description !== undefined) patch.description = args.description
  if (args.paramsSchema !== undefined) patch.params = args.paramsSchema
  upsertTemplate(templatesDir, {
    category: args.category,
    name: args.name,
    template: patch
  }, { mode: 'update' })
  return { ok: true, id: `${args.category}.${args.name}` }
}

function metaRemove(templatesDir, args) {
  if (!args || !args.category || !args.name) {
    throw new Error('meta.remove requires args.category and args.name')
  }
  const result = removeTemplate(templatesDir, args.category, args.name)
  return { ok: true, id: `${args.category}.${args.name}`, ...result }
}

function metaValidate(templatesDir, args) {
  if (!args || !args.id) {
    throw new Error('meta.validate requires args.id')
  }
  const catalog = loadCatalog(templatesDir)
  const template = catalog.get(args.id)
  if (!template) throw new Error(`unknown template: ${args.id}`)
  try {
    const bindVars = buildBindVars(template, args.args || {})
    return { ok: true, id: template.id, bindVars }
  } catch (err) {
    return { ok: false, id: template.id, error: err.message }
  }
}

export function createTemplateOwnerHandlers(arangoApi, { templatesDir }) {
  function list(payload) {
    const catalog = loadCatalog(templatesDir)
    const limit = payload.limit ?? 100
    const category = payload.category
    const matches = []
    for (const entry of catalog.values()) {
      if (category && entry.category !== category) continue
      matches.push(toRecord(entry))
      if (matches.length >= limit) break
    }
    return { templates: matches, total: matches.length, limit }
  }

  function search(payload) {
    const catalog = loadCatalog(templatesDir)
    const keywords = payload.keywords
    const limit = payload.limit ?? 100
    const matches = []
    for (const entry of catalog.values()) {
      if (!matchesKeywords(entry, keywords)) continue
      matches.push(toRecord(entry))
      if (matches.length >= limit) break
    }
    return { templates: matches, total: matches.length, limit, keywords }
  }

  function describe(payload) {
    const catalog = loadCatalog(templatesDir)
    const entry = catalog.get(payload.target)
    if (!entry) throw new Error(`unknown template: ${payload.target}`)
    return { ...toRecord(entry), query: entry.query }
  }

  async function call(payload) {
    const target = payload.target
    const args = payload.params || {}
    if (META_TARGETS.has(target)) {
      if (target === 'meta.create') return metaCreate(templatesDir, args)
      if (target === 'meta.update') return metaUpdate(templatesDir, args)
      if (target === 'meta.remove') return metaRemove(templatesDir, args)
      return metaValidate(templatesDir, args)
    }
    const catalog = loadCatalog(templatesDir)
    const template = catalog.get(target)
    if (!template) throw new Error(`unknown template: ${target}`)
    const bindVars = buildBindVars(template, args)
    const response = await arangoApi.callOperation('createAqlQueryCursor', {
      query: template.query,
      bindVars
    })
    const results = Array.isArray(response?.result) ? response.result : []
    return { template: template.id, count: results.length, results }
  }

  return {
    'templateOwner.list': list,
    'templateOwner.search': search,
    'templateOwner.describe': describe,
    'templateOwner.call': call
  }
}
