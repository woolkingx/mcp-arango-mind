/**
 * schema2object — JavaScript
 * JSON Schema IS the object class: meta (schema structure) + runtime (instance with internalized constraints).
 */

// ─── Shared resources ─────────────────────────────────────────────────────────

// Cached segmenter for grapheme-length counting
const _segmenter = new Intl.Segmenter()
const _graphemeLen = s => [..._segmenter.segment(s)].length

// RegExp cache for patternProperties
const _reCache = new Map()
const _re = pat => { if (!_reCache.has(pat)) _reCache.set(pat, new RegExp(pat)); return _reCache.get(pat) }

// ─── Deep equality ────────────────────────────────────────────────────────────

// Strict: boolean !== number even if numerically equal
function _deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => _deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
    if (ka.length !== kb.length) return false
    return ka.every((k, i) => k === kb[i] && _deepEqual(a[k], b[k]))
  }
  return false
}

// ─── Deep schema merge (for allOf) ───────────────────────────────────────────

function _deepMerge(a, b) {
  if (typeof a !== 'object' || a === null) return b
  if (typeof b !== 'object' || b === null) return b
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (k === 'properties' && out.properties) {
      out.properties = { ...out.properties }
      for (const [pk, pv] of Object.entries(v))
        out.properties[pk] = out.properties[pk] ? _deepMerge(out.properties[pk], pv) : pv
    } else if (k === 'required' && Array.isArray(out.required) && Array.isArray(v)) {
      out.required = [...new Set([...out.required, ...v])]
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = _deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

// ─── Core validator ───────────────────────────────────────────────────────────

const TYPE_CHECKS = {
  string:  v => typeof v === 'string',
  integer: v => Number.isInteger(v),
  number:  v => typeof v === 'number' && !Number.isNaN(v),
  boolean: v => typeof v === 'boolean',
  array:   v => Array.isArray(v),
  object:  v => v !== null && typeof v === 'object' && !Array.isArray(v),
  null:    v => v === null,
}

function validateType(value, schema, path, root) {
  // Boolean schema: true = accept all, false = reject all
  if (schema === true) return
  if (schema === false) throw new TypeError(`${path}: schema is false`)

  // $ref: resolve before setting root default so top-level $ref works
  if (schema.$ref !== undefined) {
    if (!root) throw new TypeError(`${path}: $ref requires root schema`)
    return validateType(value, _resolveRef(schema.$ref, root), path, root)
  }

  if (!root) root = schema

  const {
    type, const: constVal,
    minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf,
    minLength, maxLength, pattern,
    minItems, maxItems, uniqueItems, items, additionalItems, contains,
    minProperties, maxProperties, required, properties, additionalProperties, patternProperties,
    dependencies,
    enum: enumVals,
    not, oneOf, anyOf, allOf,
    if: ifSchema, then: thenSchema, else: elseSchema,
  } = schema

  // type
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]
    if (!types.some(t => TYPE_CHECKS[t]?.(value)))
      throw new TypeError(`${path}: expected ${types.join('|')}, got ${value === null ? 'null' : typeof value}`)
  }

  // const / enum
  if (constVal !== undefined && !_deepEqual(value, constVal))
    throw new TypeError(`${path}: must equal const ${JSON.stringify(constVal)}`)
  if (enumVals !== undefined && !enumVals.some(e => _deepEqual(e, value)))
    throw new TypeError(`${path}: not in enum`)

  // number constraints
  if (typeof value === 'number') {
    if (minimum !== undefined && value < minimum)
      throw new RangeError(`${path}: ${value} < minimum ${minimum}`)
    if (maximum !== undefined && value > maximum)
      throw new RangeError(`${path}: ${value} > maximum ${maximum}`)
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum)
      throw new RangeError(`${path}: ${value} <= exclusiveMinimum ${exclusiveMinimum}`)
    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum)
      throw new RangeError(`${path}: ${value} >= exclusiveMaximum ${exclusiveMaximum}`)
    if (multipleOf !== undefined) {
      const q = value / multipleOf
      if (!isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9)
        throw new RangeError(`${path}: ${value} not multipleOf ${multipleOf}`)
    }
  }

  // string constraints (grapheme length)
  if (typeof value === 'string') {
    const len = _graphemeLen(value)
    if (minLength !== undefined && len < minLength)
      throw new RangeError(`${path}: length ${len} < minLength ${minLength}`)
    if (maxLength !== undefined && len > maxLength)
      throw new RangeError(`${path}: length ${len} > maxLength ${maxLength}`)
    if (pattern !== undefined && !_re(pattern).test(value))
      throw new TypeError(`${path}: does not match pattern ${pattern}`)
  }

  // array constraints
  if (Array.isArray(value)) {
    if (minItems !== undefined && value.length < minItems)
      throw new RangeError(`${path}: length ${value.length} < minItems ${minItems}`)
    if (maxItems !== undefined && value.length > maxItems)
      throw new RangeError(`${path}: length ${value.length} > maxItems ${maxItems}`)
    if (uniqueItems) {
      // fast path: primitives only
      const allPrimitive = value.every(v => v === null || typeof v !== 'object')
      if (allPrimitive) {
        if (new Set(value.map(v => `${typeof v}:${v}`)).size !== value.length)
          throw new TypeError(`${path}: duplicate items`)
      } else {
        for (let i = 0; i < value.length; i++)
          for (let j = i + 1; j < value.length; j++)
            if (_deepEqual(value[i], value[j]))
              throw new TypeError(`${path}: duplicate items at [${i}] and [${j}]`)
      }
    }
    if (items !== undefined) {
      if (Array.isArray(items)) {
        items.forEach((s, i) => { if (i < value.length) validateType(value[i], s, `${path}[${i}]`, root) })
        if (additionalItems !== undefined && value.length > items.length)
          for (let i = items.length; i < value.length; i++)
            validateType(value[i], additionalItems, `${path}[${i}]`, root)
      } else if (items !== true) {
        value.forEach((v, i) => validateType(v, items, `${path}[${i}]`, root))
      }
    }
    if (contains !== undefined) {
      if (!value.some(v => _softValidate(v, contains, root)))
        throw new TypeError(`${path}: no item matches contains`)
    }
  }

  // object constraints
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value)
    if (minProperties !== undefined && keys.length < minProperties)
      throw new RangeError(`${path}: ${keys.length} properties < minProperties ${minProperties}`)
    if (maxProperties !== undefined && keys.length > maxProperties)
      throw new RangeError(`${path}: ${keys.length} properties > maxProperties ${maxProperties}`)
    if (required !== undefined)
      for (const k of required)
        if (!Object.prototype.hasOwnProperty.call(value, k))
          throw new TypeError(`${path}: missing required "${k}"`)
    if (properties !== undefined)
      for (const [k, s] of Object.entries(properties))
        if (Object.prototype.hasOwnProperty.call(value, k))
          validateType(value[k], s, `${path}.${k}`, root)
    if (dependencies !== undefined)
      for (const [k, dep] of Object.entries(dependencies)) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue
        if (Array.isArray(dep)) {
          for (const req of dep)
            if (!Object.prototype.hasOwnProperty.call(value, req))
              throw new TypeError(`${path}: dependency "${k}" requires "${req}"`)
        } else {
          validateType(value, dep, path, root)
        }
      }
    if (patternProperties !== undefined)
      for (const [pat, s] of Object.entries(patternProperties)) {
        const re = _re(pat)
        for (const k of keys)
          if (re.test(k)) validateType(value[k], s, `${path}.${k}`, root)
      }
    // additionalProperties: only active when schema explicitly restricts
    if (additionalProperties !== undefined) {
      const knownFromProps = properties ? Object.keys(properties) : []
      const knownFromPattern = patternProperties
        ? keys.filter(k => Object.keys(patternProperties).some(pat => _re(pat).test(k)))
        : []
      const knownKeys = new Set([...knownFromProps, ...knownFromPattern])
      for (const k of keys) {
        if (knownKeys.has(k)) continue
        if (additionalProperties === false)
          throw new TypeError(`${path}: additional property "${k}" not allowed`)
        else if (additionalProperties !== true)
          validateType(value[k], additionalProperties, `${path}.${k}`, root)
      }
    }
  }

  // not
  if (not !== undefined && _softValidate(value, not, root))
    throw new TypeError(`${path}: matches "not" schema`)

  // allOf / anyOf / oneOf
  if (allOf !== undefined)
    for (const s of allOf) validateType(value, s, path, root)
  if (anyOf !== undefined && !anyOf.some(s => _softValidate(value, s, root)))
    throw new TypeError(`${path}: matches none of anyOf`)
  if (oneOf !== undefined) {
    const n = oneOf.filter(s => _softValidate(value, s, root)).length
    if (n !== 1) throw new TypeError(`${path}: matched ${n} of oneOf (expected 1)`)
  }

  // if/then/else
  if (ifSchema !== undefined) {
    if (_softValidate(value, ifSchema, root)) {
      if (thenSchema !== undefined) validateType(value, thenSchema, path, root)
    } else {
      if (elseSchema !== undefined) validateType(value, elseSchema, path, root)
    }
  }
}

// ─── ObjectTree ───────────────────────────────────────────────────────────────

export class ObjectTree {
  #schema
  #root   // top-level schema for $ref resolution
  #value  // runtime instance value (non-object schema)
  #data   // runtime instance value (object schema)
  #path   // JSON pointer-ish path for error messages

  constructor(data, schema, path = '$') {
    this.#root = schema
    this.#path = path
    // Resolve $ref once at construction — #schema is always the concrete schema
    this.#schema = (schema && schema.$ref) ? _resolveRef(schema.$ref, this.#root) : schema
    if (this.#isObjectNode()) {
      this.#data = {}
      this.#defineProperties(this.#schema)
    }
    if (data !== undefined) this.value = data
  }

  #defineProperties(schema) {
    const { properties } = schema
    if (!properties) return
    for (const [key, subSchema] of Object.entries(properties)) {
      Object.defineProperty(this, key, {
        get: () => this.#data[key],
        set: (v) => {
          validateType(v, subSchema, `${this.#path}.${key}`, this.#root)
          this.#data[key] = v
        },
        enumerable: true, configurable: true,
      })
    }
  }

  // A node is an object node if it defines properties (with or without explicit type: 'object')
  #isObjectNode() {
    return typeof this.#schema === 'object' && this.#schema !== null
      && (this.#schema.type === 'object' || this.#schema.properties !== undefined)
  }

  // ── value: runtime instance setter/getter ──────────────────────────────────

  get value() {
    return this.#isObjectNode() ? this.#data : this.#value
  }

  set value(v) {
    validateType(v, this.#schema, this.#path, this.#root)
    if (this.#isObjectNode()) {
      this.#data = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {}
    } else {
      this.#value = v
    }
  }

  // ── Logic methods ──────────────────────────────────────────────────────────

  /** oneOf() — exactly one branch matches; returns that branch as ObjectTree */
  oneOf() {
    const schemas = this.#schema.oneOf
    if (!schemas) throw new Error('Schema has no oneOf')
    const data = this.value
    const matches = schemas.filter(s => _softValidate(data, s, this.#root))
    if (matches.length !== 1)
      throw new TypeError(`oneOf: expected exactly 1 match, got ${matches.length}`)
    return new ObjectTree(data, matches[0])
  }

  /** anyOf() — one or more branches match; returns all matching as ObjectTree[] */
  anyOf() {
    const schemas = this.#schema.anyOf
    if (!schemas) throw new Error('Schema has no anyOf')
    const data = this.value
    const matches = schemas.filter(s => _softValidate(data, s, this.#root))
    if (matches.length === 0) throw new TypeError('anyOf: no schema matched')
    return matches.map(s => new ObjectTree(data, s))
  }

  /** allOf() — deep-merge all branches; returns merged ObjectTree */
  allOf() {
    const schemas = this.#schema.allOf
    if (!schemas) throw new Error('Schema has no allOf')
    const data = this.value
    return new ObjectTree(data, schemas.reduce(_deepMerge, {}))
  }

  /** notOf() — true if data does NOT match schema.not */
  notOf() {
    const notSchema = this.#schema.not
    if (!notSchema) return true
    const data = this.value
    return !_softValidate(data, notSchema, this.#root)
  }

  /** ifThen() — evaluate if/then/else; returns chosen branch or self */
  ifThen() {
    const { if: ifSchema, then: thenSchema, else: elseSchema } = this.#schema
    if (!ifSchema) return this
    const data = this.value
    const branch = _softValidate(data, ifSchema, this.#root) ? thenSchema : elseSchema
    return branch ? new ObjectTree(data, branch) : this
  }

  /** project() — filter data to schema-defined properties, return new ObjectTree with values set */
  project() {
    const data = this.value
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      throw new TypeError('project: data must be an object')
    const props = this.#schema.properties
    const projected = new ObjectTree({}, this.#schema)
    if (props) {
      const out = {}
      for (const key of Object.keys(props))
        if (Object.prototype.hasOwnProperty.call(data, key))
          out[key] = data[key]
      projected.value = out
    }
    return projected
  }

  /** withDefaults() — return new ObjectTree with defaults applied (object only) */
  withDefaults() {
    const data = this.value
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      throw new TypeError('withDefaults: data must be an object')
    return new ObjectTree(_applyDefaults({ ...data }, this.#schema), this.#schema)
  }

  /** contains() — true if array contains at least one item matching contains schema */
  contains() {
    const data = this.value
    if (!Array.isArray(data)) return false
    const containsSchema = this.#schema.contains
    if (!containsSchema) return false
    return data.some(item => _softValidate(item, containsSchema, this.#root))
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  /** Runtime instance → plain object */
  toDict() {
    if (this.#isObjectNode()) {
      const props = this.#schema.properties
      if (!props) return { ...this.#data }
      const out = {}
      for (const key of Object.keys(props)) {
        const v = this.#data?.[key]
        if (v !== undefined) out[key] = v
      }
      return out
    }
    return this.#value
  }

  /** Schema definition → plain object */
  get schema() { return _schemaToDict(this.#schema) }

  /** Explicit schema access by path: "age" or "address.zip" */
  getSchema(path = '') {
    if (!path) return this.schema
    const parts = path.split('.').filter(Boolean)
    let node = this.#schema
    for (const part of parts) {
      if (!node || typeof node !== 'object') return undefined
      const props = node.properties
      if (!props || !(part in props)) return undefined
      node = props[part]
    }
    return _schemaToDict(node)
  }

  /** Return x-* extensions on a schema node (optionally by path) */
  getExtensions(path = '') {
    const node = path ? this.getSchema(path) : this.schema
    if (!node || typeof node !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('x-')) out[k] = v
    }
    return out
  }

  toJSON() { return JSON.stringify(this.toDict(), null, 2) }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a JSON Pointer $ref against root schema */
function _resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new TypeError(`Unsupported $ref: ${ref}`)
  const parts = ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))
  let node = root
  for (const part of parts) {
    if (node == null || typeof node !== 'object') throw new TypeError(`$ref path not found: ${ref}`)
    node = node[part]
  }
  if (node === undefined) throw new TypeError(`$ref not found: ${ref}`)
  return node
}

/** Soft validate: ObjectTree is the validator — try setting value, catch = invalid */
function _softValidate(data, schema, root) {
  try { new ObjectTree(data, schema); return true } catch { return false }
}

/** Schema → plain object (for schema() method) */
function _schemaToDict(schema) {
  if (schema === null || typeof schema !== 'object') return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties') {
      out.properties = {}
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = _schemaToDict(pv)
    } else if (Array.isArray(v)) {
      out[k] = v.map(_schemaToDict)
    } else if (typeof v === 'object' && v !== null) {
      out[k] = _schemaToDict(v)
    } else {
      out[k] = v
    }
  }
  return out
}

/** Apply defaults from schema.properties recursively (object only) */
function _applyDefaults(data, schema) {
  if (!schema || typeof schema !== 'object') return data
  const props = schema.properties
  if (!props || typeof props !== 'object') return data
  for (const [k, s] of Object.entries(props)) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      if (data[k] && typeof data[k] === 'object' && !Array.isArray(data[k]))
        data[k] = _applyDefaults({ ...data[k] }, s)
    } else if (s && typeof s === 'object' && Object.prototype.hasOwnProperty.call(s, 'default')) {
      data[k] = s.default
    }
  }
  return data
}
