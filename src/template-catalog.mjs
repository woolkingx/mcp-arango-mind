import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

function readCategory(file) {
  const raw = readFileSync(file, 'utf8')
  return JSON.parse(raw)
}

function categoryPath(templatesDir, category) {
  return join(templatesDir, `${category}.json`)
}

export function loadCatalog(templatesDir) {
  const catalog = new Map()
  if (!existsSync(templatesDir)) return catalog
  for (const file of readdirSync(templatesDir)) {
    if (!file.endsWith('.json')) continue
    const data = readCategory(join(templatesDir, file))
    const category = data.category || file.replace(/\.json$/, '')
    const templates = data.templates || {}
    for (const [name, template] of Object.entries(templates)) {
      const id = `${category}.${name}`
      catalog.set(id, {
        id,
        category,
        name,
        query: template.query,
        description: template.description || '',
        params: template.params || {}
      })
    }
  }
  return catalog
}

export function saveCategory(templatesDir, category, payload) {
  if (!existsSync(templatesDir)) mkdirSync(templatesDir, { recursive: true })
  const file = categoryPath(templatesDir, category)
  const data = { category, description: payload.description || '', templates: payload.templates || {} }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

export function upsertTemplate(templatesDir, entry, { mode }) {
  const file = categoryPath(templatesDir, entry.category)
  const existing = existsSync(file) ? readCategory(file) : { category: entry.category, description: '', templates: {} }
  const templates = existing.templates || {}
  const has = Object.prototype.hasOwnProperty.call(templates, entry.name)
  if (mode === 'create' && has) throw new Error(`template already exists: ${entry.category}.${entry.name}`)
  if (mode === 'update' && !has) throw new Error(`template not found: ${entry.category}.${entry.name}`)
  const next = mode === 'update' ? { ...templates[entry.name], ...entry.template } : entry.template
  templates[entry.name] = {
    query: next.query,
    description: next.description || '',
    params: next.params || {}
  }
  saveCategory(templatesDir, entry.category, { description: existing.description, templates })
  return templates[entry.name]
}

export function removeTemplate(templatesDir, category, name) {
  const file = categoryPath(templatesDir, category)
  if (!existsSync(file)) throw new Error(`template not found: ${category}.${name}`)
  const existing = readCategory(file)
  const templates = existing.templates || {}
  if (!Object.prototype.hasOwnProperty.call(templates, name)) {
    throw new Error(`template not found: ${category}.${name}`)
  }
  delete templates[name]
  if (Object.keys(templates).length === 0) {
    unlinkSync(file)
    return { removedCategory: true }
  }
  saveCategory(templatesDir, category, { description: existing.description, templates })
  return { removedCategory: false }
}

function coerce(value, type) {
  if (value === null || value === undefined) return value
  if (type === 'int') {
    const n = Number(value)
    if (!Number.isInteger(n)) throw new Error(`expected int, got ${typeof value}`)
    return n
  }
  if (type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) throw new Error(`expected number, got ${typeof value}`)
    return n
  }
  return value
}

function collectionVarsInQuery(query) {
  const names = new Set()
  if (typeof query !== 'string') return names
  const re = /@@([A-Za-z_][A-Za-z0-9_]*)/g
  let match
  while ((match = re.exec(query)) !== null) names.add(match[1])
  return names
}

export function buildBindVars(template, params = {}) {
  const schema = template.params || {}
  const bindVars = {}
  for (const [key, spec] of Object.entries(schema)) {
    if (spec && typeof spec === 'object') {
      if (spec.required && !(key in params)) {
        throw new Error(`missing required parameter: ${key}`)
      }
      const provided = key in params ? params[key] : spec.default
      bindVars[key] = coerce(provided, spec.type)
    } else {
      bindVars[key] = params[key]
    }
  }
  const collectionNames = collectionVarsInQuery(template.query)
  const rewritten = {}
  for (const [key, value] of Object.entries(bindVars)) {
    if (collectionNames.has(key)) rewritten[`@${key}`] = value
    else rewritten[key] = value
  }
  return rewritten
}
