/**
 * schema2object — JavaScript
 * JSON Schema IS the object class.
 * Spec: docs/draft-07-spec.json
 */

import { readFileSync } from 'fs'
import { join as pathJoin, dirname } from 'path'

// ─── Shared ──────────────────────────────────────────────────────────────────

const _unicodeLen = s => [...s].length
const _unescapePointer = p => p.replace(/~[01]/g, m => m === '~1' ? '/' : '~')
const _reCache = new Map()
const _re = pat => { if (!_reCache.has(pat)) _reCache.set(pat, new RegExp(pat)); return _reCache.get(pat) }

// ─── Deep equality ───────────────────────────────────────────────────────────

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

// ─── Deep schema merge ───────────────────────────────────────────────────────

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

// ─── URI helpers ─────────────────────────────────────────────────────────────

function _resolveUri(ref, base) {
  if (!base || ref.match(/^[a-zA-Z][a-zA-Z0-9+\-.]*:/)) return ref
  if (ref.startsWith('#')) return ref
  try { return new URL(ref, base).href } catch { return ref }
}

function _splitFragment(uri) {
  const idx = uri.indexOf('#')
  if (idx === -1) return [uri, null]
  const frag = uri.slice(idx + 1)
  return [uri.slice(0, idx), frag || null]
}

function _jsonPointer(root, pointer, percentDecode = false) {
  // pointer starts with '/'
  const parts = pointer.replace(/^\//, '').split('/').map(p => {
    const unescaped = _unescapePointer(p)
    return percentDecode ? decodeURIComponent(unescaped) : unescaped
  })
  let node = root
  for (const p of parts) {
    if (node == null || typeof node !== 'object') throw new TypeError(`$ref path not found: ${pointer}`)
    node = node[p]
  }
  if (node === undefined) throw new TypeError(`$ref not found: ${pointer}`)
  return node
}

// ─── Loader ───────────────────────────────────────────────────────────────────
// Resolves $ref per JSON Schema Draft-07 URI semantics:
//   '#'        → root
//   '#/path'   → JSON Pointer in root
//   '#anchor'  → named anchor ($id scan)
//   absolute   → remote file (mapped from http://localhost:1234/ → remoteDir)
//   relative   → resolved against base URI → same as above

export class Loader {
  #root
  #idMap       // Map<uri|'#anchor', node>
  #scopeMap    // WeakMap<node, baseUri> — effective resolution scope per node
  #resolver    // string (dir) | object (uri→schema map) | function (uri→schema) | null
  #remoteCache // Map<docUri, Loader>

  constructor(root, resolver, documentBase) {
    this.#root = root
    this.#resolver = resolver || null
    this.#remoteCache = new Map()
    this.#idMap = new Map()
    this.#scopeMap = new WeakMap()
    const rawBase = documentBase || (typeof root.$id === 'string' ? root.$id : null)
    const base = rawBase?.endsWith('#') ? rawBase.slice(0, -1) : rawBase
    this.#scanIds(root, base, base)
  }

  #scanIds(node, baseUri, resourceRoot) {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) { node.forEach(n => this.#scanIds(n, baseUri, resourceRoot)); return }

    let currentBase = baseUri
    let currentResource = resourceRoot  // URI of nearest ancestor with $id
    if (typeof node.$id === 'string') {
      currentBase = _resolveUri(node.$id, baseUri)
      // Normalize: strip trailing bare '#'
      const normalized = currentBase.endsWith('#') ? currentBase.slice(0, -1) : currentBase
      this.#idMap.set(normalized, node)
      if (normalized !== currentBase) this.#idMap.set(currentBase, node)
      if (node.$id.startsWith('#')) this.#idMap.set(node.$id, node)
      currentBase = normalized
      currentResource = normalized  // this node IS a resource root
    }
    // scope = base URI for resolving relative $ref (includes own $id)
    // parentScope = base URI BEFORE this node's $id (for $ref sibling-$id-ignore rule)
    // resource = nearest $id-bearing ancestor URI (for '#' resolution)
    this.#scopeMap.set(node, { scope: currentBase, parentScope: baseUri, resource: currentResource })
    for (const v of Object.values(node)) this.#scanIds(v, currentBase, currentResource)
  }

  // scope: base URI for relative $ref resolution (includes own $id)
  scopeOf(node) {
    return this.#scopeMap.get(node)?.scope || null
  }

  // parentScope: base URI ignoring own $id — used when $ref is present (sibling $id ignored)
  parentScopeOf(node) {
    return this.#scopeMap.get(node)?.parentScope || null
  }

  // resource: nearest $id-bearing ancestor URI — this is what '#' refers to
  resourceOf(node) {
    return this.#scopeMap.get(node)?.resource || null
  }

  resolve(ref, baseUri, resourceUri) {
    // '#' = root of the nearest $id-bearing resource
    if (ref === '#') {
      const resNode = resourceUri ? this.#idMap.get(resourceUri) : null
      return { node: resNode || this.#root, loader: this }
    }

    // '#/path' — JSON Pointer relative to nearest resource root
    if (ref.startsWith('#/')) {
      const resNode = resourceUri ? this.#idMap.get(resourceUri) : null
      const docRoot = resNode || this.#root
      return { node: _jsonPointer(docRoot, ref.slice(1), true), loader: this }
    }

    // Named anchor (fragment-only, not a pointer)
    if (ref.startsWith('#')) {
      if (this.#idMap.has(ref)) return { node: this.#idMap.get(ref), loader: this }
      throw new TypeError(`$ref anchor not found: ${ref}`)
    }

    // Resolve relative ref against base URI
    const resolved = _resolveUri(ref, baseUri)
    const [docUri, fragment] = _splitFragment(resolved)

    // Check $id map for the document part
    const docNode = this.#idMap.get(docUri) ?? this.#idMap.get(resolved)
    if (docNode) {
      if (!fragment) return { node: docNode, loader: this }
      // Navigate fragment within the found node using a sub-loader
      // so that '#/definitions/inner' resolves within docNode, not root
      const subLoader = new Loader(docNode, this.#resolver)
      return subLoader.resolve('#' + fragment, null)
    }

    // External loading — http(s) URI or any unresolved ref with a resolver
    if (resolved.match(/^https?:\/\//) || this.#resolver) {
      return this.#resolveRemote(docUri, fragment, ref)
    }

    throw new TypeError(`Unsupported $ref: ${ref}`)
  }

  #resolveRemote(docUri, fragment, originalRef) {
    if (!this.#remoteCache.has(docUri)) {
      const schema = this.#loadSchema(docUri, originalRef)
      this.#remoteCache.set(docUri, new Loader(schema, this.#resolver, docUri))
    }
    const subLoader = this.#remoteCache.get(docUri)
    if (!fragment) return { node: subLoader.#root, loader: subLoader }
    return subLoader.resolve('#' + fragment, null)
  }

  #loadSchema(docUri, originalRef) {
    const r = this.#resolver
    if (!r) throw new TypeError(`$ref remote not supported (no resolver): ${docUri}`)

    // function resolver: call it directly
    if (typeof r === 'function') {
      const schema = r(docUri) ?? (originalRef ? r(originalRef) : null)
      if (!schema) throw new TypeError(`$ref resolver returned nothing for: ${docUri}`)
      return schema
    }

    // object resolver: try resolved URI, then original ref as key
    if (typeof r === 'object' && !Array.isArray(r)) {
      const schema = r[docUri] ?? (originalRef ? r[originalRef] : null)
      if (schema) return schema
      throw new TypeError(`$ref not found in schema map: ${docUri}`)
    }

    // string resolver: directory path — strip scheme+host from http(s) URI, look up file
    if (typeof r === 'string') {
      const m = docUri.match(/^https?:\/\/[^/]+\/(.*)$/)
      const filePath = m ? m[1] : docUri  // fallback: use URI as relative path
      let full = pathJoin(r, filePath)
      if (!this.#fileExists(full)) full = full + '.json'
      try { return JSON.parse(readFileSync(full, 'utf8')) }
      catch { throw new TypeError(`$ref file not found: ${full}`) }
    }

    throw new TypeError(`$ref unsupported resolver type: ${typeof r}`)
  }

  #fileExists(p) {
    try { readFileSync(p); return true } catch { return false }
  }

  get root() { return this.#root }
  get resolver() { return this.#resolver }
}

// ─── Soft validate ───────────────────────────────────────────────────────────

function _softValidate(data, schema, loader) {
  try { validateType(data, schema, '$', loader); return true } catch { return false }
}

// ─── Type checks ─────────────────────────────────────────────────────────────

const TYPE_CHECKS = {
  string:  v => typeof v === 'string',
  integer: v => typeof v === 'number' && !Number.isNaN(v) && Number.isInteger(v),
  number:  v => typeof v === 'number' && !Number.isNaN(v),
  boolean: v => typeof v === 'boolean',
  array:   v => Array.isArray(v),
  object:  v => v !== null && typeof v === 'object' && !Array.isArray(v),
  null:    v => v === null,
}

// ─── Core validator ──────────────────────────────────────────────────────────

function validateType(value, schema, path = '$', loader) {
  if (schema === true) return
  if (schema === false) throw new TypeError(`${path}: schema is false`)

  // $ref → resolve and delegate; sibling keywords ignored (Draft 4-7)
  if (schema.$ref !== undefined) {
    if (!loader) loader = new Loader(schema)
    // Per Draft 4-7: when $ref is present, sibling $id is ignored for base URI resolution
    const baseUri = loader.parentScopeOf(schema)
    const resourceUri = loader.resourceOf(schema)
    const { node, loader: refLoader } = loader.resolve(schema.$ref, baseUri, resourceUri)
    return validateType(value, node, path, refLoader)
  }

  if (!loader) loader = new Loader(schema)

  const {
    type, const: constVal,
    minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf,
    minLength, maxLength, pattern,
    minItems, maxItems, uniqueItems, items, additionalItems, contains,
    minProperties, maxProperties, required, properties, additionalProperties,
    patternProperties, propertyNames, dependencies,
    enum: enumVals,
    not, oneOf, anyOf, allOf,
    if: ifSchema, then: thenSchema, else: elseSchema,
  } = schema

  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]
    if (typeof value === 'boolean' && !types.includes('boolean'))
      throw new TypeError(`${path}: expected ${types.join('|')}, got boolean`)
    if (!types.some(t => TYPE_CHECKS[t]?.(value)))
      throw new TypeError(`${path}: expected ${types.join('|')}, got ${value === null ? 'null' : typeof value}`)
  }

  if (constVal !== undefined && !_deepEqual(value, constVal))
    throw new TypeError(`${path}: must equal const ${JSON.stringify(constVal)}`)
  if (enumVals !== undefined && !enumVals.some(e => _deepEqual(e, value)))
    throw new TypeError(`${path}: not in enum`)

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
      if (!isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q)))
        throw new RangeError(`${path}: ${value} not multipleOf ${multipleOf}`)
    }
  }

  if (typeof value === 'string') {
    const len = _unicodeLen(value)
    if (minLength !== undefined && len < minLength)
      throw new RangeError(`${path}: length ${len} < minLength ${minLength}`)
    if (maxLength !== undefined && len > maxLength)
      throw new RangeError(`${path}: length ${len} > maxLength ${maxLength}`)
    if (pattern !== undefined && !_re(pattern).test(value))
      throw new TypeError(`${path}: does not match pattern ${pattern}`)
  }

  if (Array.isArray(value)) {
    if (minItems !== undefined && value.length < minItems)
      throw new RangeError(`${path}: length ${value.length} < minItems ${minItems}`)
    if (maxItems !== undefined && value.length > maxItems)
      throw new RangeError(`${path}: length ${value.length} > maxItems ${maxItems}`)
    if (uniqueItems) {
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
        items.forEach((s, i) => { if (i < value.length) validateType(value[i], s, `${path}[${i}]`, loader) })
        if (value.length > items.length && additionalItems !== undefined)
          for (let i = items.length; i < value.length; i++)
            validateType(value[i], additionalItems, `${path}[${i}]`, loader)
      } else {
        value.forEach((v, i) => validateType(v, items, `${path}[${i}]`, loader))
      }
    }
    if (contains !== undefined) {
      if (!value.some(v => _softValidate(v, contains, loader)))
        throw new TypeError(`${path}: no item matches contains`)
    }
  }

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
    if (propertyNames !== undefined)
      for (const k of keys)
        validateType(k, propertyNames, `${path}/<key:${k}>`, loader)
    if (properties !== undefined)
      for (const [k, s] of Object.entries(properties))
        if (Object.prototype.hasOwnProperty.call(value, k))
          validateType(value[k], s, `${path}.${k}`, loader)
    if (patternProperties !== undefined)
      for (const [pat, s] of Object.entries(patternProperties)) {
        const re = _re(pat)
        for (const k of keys)
          if (re.test(k)) validateType(value[k], s, `${path}.${k}`, loader)
      }
    if (additionalProperties !== undefined && additionalProperties !== true) {
      const knownFromProps = properties ? new Set(Object.keys(properties)) : new Set()
      const ppPatterns = patternProperties ? Object.keys(patternProperties).map(p => _re(p)) : []
      for (const k of keys) {
        if (knownFromProps.has(k)) continue
        if (ppPatterns.some(re => re.test(k))) continue
        if (additionalProperties === false)
          throw new TypeError(`${path}: additional property "${k}" not allowed`)
        validateType(value[k], additionalProperties, `${path}.${k}`, loader)
      }
    }
    if (dependencies !== undefined)
      for (const [k, dep] of Object.entries(dependencies)) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue
        if (Array.isArray(dep)) {
          for (const req of dep)
            if (!Object.prototype.hasOwnProperty.call(value, req))
              throw new TypeError(`${path}: dependency "${k}" requires "${req}"`)
        } else {
          validateType(value, dep, path, loader)
        }
      }
  }

  if (not !== undefined && _softValidate(value, not, loader))
    throw new TypeError(`${path}: matches "not" schema`)

  if (allOf !== undefined)
    for (const s of allOf) validateType(value, s, path, loader)
  if (anyOf !== undefined && !anyOf.some(s => _softValidate(value, s, loader)))
    throw new TypeError(`${path}: matches none of anyOf`)
  if (oneOf !== undefined) {
    const n = oneOf.filter(s => _softValidate(value, s, loader)).length
    if (n !== 1) throw new TypeError(`${path}: matched ${n} of oneOf (expected 1)`)
  }

  if (ifSchema !== undefined) {
    if (_softValidate(value, ifSchema, loader)) {
      if (thenSchema !== undefined) validateType(value, thenSchema, path, loader)
    } else {
      if (elseSchema !== undefined) validateType(value, elseSchema, path, loader)
    }
  }
}

// ─── ObjectTree ──────────────────────────────────────────────────────────────

export class ObjectTree {
  #schema
  #loader
  #value
  #data
  #path

  constructor(data, schema, resolver) {
    // resolver: Loader (reuse existing — internal re-bind only)
    //         | string (schema file path → dirname used as base dir)
    //         | object (uri → schema map)
    //         | function (uri → schema)
    //         | undefined (no external $ref)
    const loader = resolver instanceof Loader
      ? resolver
      : new Loader(schema, typeof resolver === 'string' ? dirname(resolver) : (resolver || null))
    this.#path = '$'
    if (schema && typeof schema === 'object' && schema.$ref) {
      const { node, loader: refLoader } = loader.resolve(
        schema.$ref, loader.scopeOf(schema), loader.resourceOf(schema))
      this.#schema = node
      this.#loader = refLoader
    } else {
      this.#schema = schema
      this.#loader = loader
    }
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
      const resolved = subSchema?.$ref
        ? this.#loader.resolve(subSchema.$ref, this.#loader.scopeOf(subSchema), this.#loader.resourceOf(subSchema)).node
        : subSchema
      const def = Object.prototype.hasOwnProperty.call(subSchema ?? {}, 'default') ? subSchema.default
                : (resolved && Object.prototype.hasOwnProperty.call(resolved, 'default')) ? resolved.default
                : undefined
      if (def !== undefined)
        this.#data[key] = typeof def === 'object' && def !== null ? structuredClone(def) : def
      Object.defineProperty(this, key, {
        get: () => this.#data[key],
        set: (v) => {
          validateType(v, subSchema, `${this.#path}.${key}`, this.#loader)
          this.#data[key] = v
        },
        enumerable: true, configurable: true,
      })
    }
  }

  #isObjectNode() {
    return typeof this.#schema === 'object' && this.#schema !== null
      && (this.#schema.type === 'object' || this.#schema.properties !== undefined)
  }

  get value() {
    return this.#isObjectNode() ? this.#data : this.#value
  }

  set value(v) {
    validateType(v, this.#schema, this.#path, this.#loader)
    if (this.#isObjectNode()) {
      this.#data = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {}
    } else {
      this.#value = v
    }
  }

  oneOf() {
    const schemas = this.#schema.oneOf
    if (!schemas) throw new Error('Schema has no oneOf')
    const data = this.value
    const matches = schemas.filter(s => _softValidate(data, s, this.#loader))
    if (matches.length !== 1)
      throw new TypeError(`oneOf: expected exactly 1 match, got ${matches.length}`)
    return new ObjectTree(data, matches[0], this.#loader)
  }

  anyOf() {
    const schemas = this.#schema.anyOf
    if (!schemas) throw new Error('Schema has no anyOf')
    const data = this.value
    const matches = schemas.filter(s => _softValidate(data, s, this.#loader))
    if (matches.length === 0) throw new TypeError('anyOf: no schema matched')
    return matches.map(s => new ObjectTree(data, s, this.#loader))
  }

  allOf() {
    const schemas = this.#schema.allOf
    if (!schemas) throw new Error('Schema has no allOf')
    const data = this.value
    return new ObjectTree(data, schemas.reduce(_deepMerge, {}), this.#loader)
  }

  notOf() {
    const notSchema = this.#schema.not
    if (!notSchema) return true
    return !_softValidate(this.value, notSchema, this.#loader)
  }

  ifThen() {
    const { if: ifSchema, then: thenSchema, else: elseSchema } = this.#schema
    if (!ifSchema) return this
    const data = this.value
    const branch = _softValidate(data, ifSchema, this.#loader) ? thenSchema : elseSchema
    return branch ? new ObjectTree(data, branch, this.#loader) : this
  }

  project() {
    const data = this.value
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      throw new TypeError('project: data must be an object')
    const props = this.#schema.properties
    if (!props) return new ObjectTree(data, this.#schema, this.#loader)
    const out = {}
    for (const key of Object.keys(props))
      if (Object.prototype.hasOwnProperty.call(data, key))
        out[key] = data[key]
    const projected = new ObjectTree(undefined, this.#schema, this.#loader)
    projected.#data = out
    return projected
  }

  withDefaults() {
    const data = this.value
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      throw new TypeError('withDefaults: data must be an object')
    return new ObjectTree(_applyDefaults({ ...data }, this.#schema, this.#loader), this.#schema, this.#loader)
  }

  contains() {
    const data = this.value
    if (!Array.isArray(data)) return null
    const cs = this.#schema.contains
    if (!cs) return null
    return data.some(item => _softValidate(item, cs, this.#loader))
  }

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

  get schema() { return _schemaToDict(this.#schema) }

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function _applyDefaults(data, schema, loader) {
  if (!schema || typeof schema !== 'object') return data
  const resolved = schema.$ref
    ? loader.resolve(schema.$ref, schema.$id || null).node
    : schema
  const props = resolved.properties
  if (!props || typeof props !== 'object') return data
  for (const [k, rawS] of Object.entries(props)) {
    const s = rawS?.$ref ? loader.resolve(rawS.$ref, rawS.$id || null).node : rawS
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      if (data[k] && typeof data[k] === 'object' && !Array.isArray(data[k]))
        data[k] = _applyDefaults({ ...data[k] }, rawS, loader)
    } else {
      const def = Object.prototype.hasOwnProperty.call(rawS ?? {}, 'default') ? rawS.default
                : (s && Object.prototype.hasOwnProperty.call(s, 'default')) ? s.default
                : undefined
      if (def !== undefined)
        data[k] = typeof def === 'object' && def !== null ? structuredClone(def) : def
    }
  }
  return data
}

// ─── validate ─────────────────────────────────────────────────────────────────

export function validate(data, schema, resolver) {
  try {
    new ObjectTree(data, schema, resolver)
    return { valid: true }
  } catch (e) {
    return { valid: false, error: e.message }
  }
}

