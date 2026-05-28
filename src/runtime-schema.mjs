import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validate } from './lib/schema2object.mjs'

const PROJECT_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const DEFAULT_SCHEMA_DIR = join(PROJECT_ROOT, 'config', 'schemas')
const SEGMENT_ROLES = ['state', 'object', 'property', 'subcoordinate']
const RUNTIME_SCHEMA_FILE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['collection', 'schema'],
  properties: {
    name: { type: 'string', minLength: 1 },
    collection: { type: 'string', minLength: 1 },
    schema: {
      type: 'object',
      additionalProperties: true
    }
  }
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function normalizeValidationErrors(result) {
  if (result.valid) return []
  return Array.isArray(result.errors) ? result.errors : [result.error || 'runtime schema validation failed']
}

function runtimeSchemaFileRecord(file, path) {
  const record = loadJson(path)
  const result = validate(record, RUNTIME_SCHEMA_FILE_SCHEMA)
  if (!result.valid) {
    throw new Error(`invalid runtime schema file ${file}: ${normalizeValidationErrors(result).join('; ')}`)
  }
  return record
}

export function loadRuntimeSchemas(schemaDir = DEFAULT_SCHEMA_DIR) {
  const schemas = new Map()
  if (!existsSync(schemaDir)) return schemas
  for (const file of readdirSync(schemaDir).filter(name => name.endsWith('.json')).sort()) {
    const record = runtimeSchemaFileRecord(file, join(schemaDir, file))
    schemas.set(record.collection, {
      name: record.name || record.collection,
      collection: record.collection,
      schema: record.schema,
      source: join(schemaDir, file)
    })
  }
  return schemas
}

function extensionErrors(collection, schema, document) {
  const errors = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return errors
  const properties = schema.properties || {}
  for (const [field, fieldSchema] of Object.entries(properties)) {
    const firstLevel = fieldSchema?.['x-first-level']
    if (!Array.isArray(firstLevel) || document[field] === undefined) continue
    const value = document[field]
    if (!Array.isArray(value)) continue
    if (value.length === 0) continue
    if (!firstLevel.includes(value[0])) {
      errors.push(`${collection}.${field}[0]: "${value[0]}" outside x-first-level ${JSON.stringify(firstLevel)}`)
    }
  }
  return errors
}

function normalizeMode(options) {
  if (typeof options === 'string') return options
  if (options && typeof options === 'object' && typeof options.mode === 'string') return options.mode
  return 'full'
}

function partialSchema(schema, document) {
  const next = clone(schema)
  delete next.required
  if (!next.properties || !document || typeof document !== 'object' || Array.isArray(document)) return next

  const properties = {}
  for (const key of Object.keys(document)) {
    if (Object.prototype.hasOwnProperty.call(next.properties, key)) {
      properties[key] = next.properties[key]
    }
  }
  next.properties = properties
  return next
}

export function createRuntimeSchemaRegistry({ schemaDir = DEFAULT_SCHEMA_DIR } = {}) {
  const schemas = loadRuntimeSchemas(schemaDir)

  function getRecord(collection) {
    const record = schemas.get(collection)
    if (!record) throw new Error(`unknown runtime schema collection: ${collection}`)
    return record
  }

  function hasSchema(collection) {
    return schemas.has(collection)
  }

  function listCollections() {
    return [...schemas.keys()].sort()
  }

  function getRuntimeSchema(collection) {
    return clone(getRecord(collection).schema)
  }

  function getFieldRule(collection, field) {
    const schema = getRecord(collection).schema
    const fieldSchema = schema.properties?.[field]
    if (!fieldSchema) throw new Error(`unknown runtime schema field: ${collection}.${field}`)
    return clone(fieldSchema)
  }

  function getTypeRule(collection = 'notes') {
    const fieldSchema = getFieldRule(collection, 'type')
    return {
      field: 'type',
      firstLevel: clone(fieldSchema['x-first-level'] || []),
      segmentRoles: clone(SEGMENT_ROLES)
    }
  }

  function validateDocument(collection, document, options) {
    const mode = normalizeMode(options)
    if (!['full', 'partial'].includes(mode)) throw new Error(`unknown runtime schema validation mode: ${mode}`)
    const schema = getRecord(collection).schema
    const activeSchema = mode === 'partial' ? partialSchema(schema, document) : schema
    const result = validate(document, activeSchema)
    const errors = normalizeValidationErrors(result).concat(extensionErrors(collection, schema, document))
    return { valid: errors.length === 0, errors }
  }

  return {
    hasSchema,
    listCollections,
    getRuntimeSchema,
    getFieldRule,
    getTypeRule,
    validate: validateDocument
  }
}
