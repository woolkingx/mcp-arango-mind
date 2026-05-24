# schema2object Usage Guide

Local handbook snapshot for `mcp-arango-mind`.

Source snapshot:

```text
/home/claude/projects/schema2object/master/js/docs/schema2object-usage.md
```

Handbook bridge:

```text
schema2object.html
```

> **Foundation document** - Everything in jster is built on this. Master ObjectTree, master the system.

This is the operational guide for `schema2object`.

Current mainline: `v0.6.1` pointer + proxy + lazy.

- It explains how to build, resolve, validate, and access schema-backed runtime objects.
- It does not define the runtime boundary of `jster`.
- For `mcp-arango-mind` boundaries and layer semantics, read [`topology.html`](topology.html), [`owners.html`](owners.html), and [`schema2object.html`](schema2object.html) alongside this guide.

## Core Concept

`schema2object` (ObjectTree) turns JSON Schema into live data objects. Schema defines structure, data gives values. Don't mix them up.

## Relationship To Architecture

- `schema2object-usage.md` answers: how do I use the type/instance kernel correctly?
- `topology.html` answers: what legal edge the kernel serves.
- `owners.html` answers: which data owner the schema-backed object belongs to.

If you are fixing validation, `$ref` scope, defaults, proxy access, or schema resolution, stay here.
If you are deciding where a capability belongs in the runtime, switch to `topology.html` and `owners.html`.

## Access Semantics

- `tree.key` is live access. It returns wrapped nested values when the value is an object or array.
- `{ ...tree }` is enumeration/materialization. It returns a shallow plain object with raw values.
- `Object.keys(tree)` is only key enumeration. It does not materialize nested values.

Do not assume spread and direct property access are the same operation. They share the same source data, but they do not share the same semantics.

## The Right Way: Loader -> resolve -> ObjectTree

### 1. Boot: Root Loader loads everything

In jster runtime, the root loader is created by core and already knows the schema graph.

```js
import { Loader, ObjectTree } from './schema2object.mjs'

const configSchema = JSON.parse(readFileSync('config.json', 'utf-8'))
const rootLoader = new Loader(configSchema, dirname(configSchemaPath))
// rootLoader now has ALL schemas via $ref chain
```

### 2. Resolve: Get node + sub-loader with correct scope

```js
const { node, loader: subLoader } = rootLoader.resolve('definitions.json#/definitions/Rule')
// node = Rule schema definition
// subLoader scope = definitions.json (so #/definitions/... resolves correctly)
```

**Key point**: the returned loader carries the correct `#` scope. Always use it.

### 3. ObjectTree: Schema defines structure, data gives values

```js
// Strip required/if/then for empty init (assign values via Proxy set)
const schema = { type: 'object', properties: node.properties }
const rule = new ObjectTree({}, schema, subLoader)

// Assign values - Proxy set handles dot keys
for (const [k, v] of Object.entries(data)) rule[k] = v
```

Or pass data directly (must satisfy `required`):

```js
const rule = new ObjectTree(data, node, subLoader)
```

## Dual-Mode Representation: Flat Dot Keys + Nested Objects (v0.5.1+)

**Core Design**: ObjectTree supports two equivalent representations - flat dot keys (human-friendly authoring) and nested objects (programmatic access). Proxy set automatically converts between them.

### Flat Mode - Human-Friendly Authoring

```json
{
  "name": "deny-rm",
  "event": "PreToolUse",
  "action": "deny",
  "match.command.name": "rm"
}
```

### Nested Mode - Programmatic Access

```json
{
  "name": "deny-rm",
  "event": "PreToolUse",
  "action": "deny",
  "match": {
    "command": {
      "name": "rm"
    }
  }
}
```

### Automatic Conversion via Proxy Set

```js
const tree = new ObjectTree({}, schema, loader)
tree['match.command.name'] = 'rm'

console.log(tree.match.command.name) // 'rm'
console.log(tree.$toDict())
// { match: { command: { name: 'rm' } } }
```

**Design Benefits:**
- **Authoring**: Flat keys reduce visual nesting, easier to scan and edit
- **Validation**: Schema constraints apply to nested structure (type/enum/required)
- **Flexibility**: Use whichever mode suits the task (JSON files = flat, code = nested)
- **Interoperability**: Both modes produce identical internal structure

**jster use case**: Module config files use flat keys for readability, runtime uses nested access for type safety.

## Observer Hook (v0.5.2+)

Global hook for reactive bindings, logging, or instrumentation. Receives schema metadata as 5th parameter.

```js
// Signature: fn(op, path, key, val, schema)
// op = 'get' | 'set'
// path = JSON path string (e.g., '$.user.address')
// key = property name
// val = value being read/written
// schema = schema node for the property (undefined if no constraint)

ObjectTree._observer = (op, path, key, val, schema) => {
  if (schema?.['x-observable'] === false) return

  const type = schema?.type || 'any'
  const desc = schema?.description || ''
  console.log(`[${op}] ${path}.${key} (${type}): ${desc}`)
}

const user = new ObjectTree({ name: 'Alice', age: 30 }, schema)
user.name // logs: [get] $.name (string): ...
user.age = 31 // logs: [set] $.age (integer): ...

ObjectTree._observer = null  // disable (zero cost)
```

**Use cases:**
- **Filter by extension**: Skip properties with `x-observable: false`
- **Format-aware serialization**: Use `schema.format` to serialize dates/emails
- **Type-aware logging**: Log with type/description metadata
- **Reactive bindings**: Build UI bindings, change tracking, etc.

## API Quick Reference

| API | Direction | Purpose |
|-----|-----------|---------|
| `tree.a.b.c` | get | Chain Proxy get, each level returns ObjectTree |
| `tree['a.b.c'] = v` | set | Dot key Proxy set, walks schema path |
| `tree.$toDict()` | export | One-way exit to plain object |
| `tree.$withDefaults()` | init | Apply schema defaults, return self |
| `tree.$getSchema('a.b.c')` | query | Get sub-schema at dot path |
| `tree.$value` | get | Raw primitive value or full data object |

## Default Application

Schema `default` is treated as the initial value of a property. Reads, enumeration, and explicit materialization each behave differently — keep them straight.

### Read semantics: lazy, transparent

```js
const schema = {
  type: 'object',
  properties: {
    retries: { type: 'integer', default: 3 },
    name:    { type: 'string' }
  }
}

const tree = new ObjectTree({ name: 'job' }, schema)

tree.retries        // 3   ← read from schema.default, raw is unchanged
'retries' in tree   // true
Object.keys(tree)   // ['name', 'retries']   ← default-only keys included
tree.$value.retries // undefined ← raw data was never mutated
```

A missing key with a `default` is read transparently from the schema. The raw object is **not** mutated, and `$value` still reflects the original data. `Object.keys()` and `in` include default-only keys so iteration matches read semantics.

### Construction: validate but do not write

When `new ObjectTree(data, schema, loader)` runs, every `default` reachable via `properties` is validated against its sub-schema. **An invalid default throws at construction time** — this is the only place defaults touch the validator. Construction does not merge defaults into your raw data. If you want the merged shape, use `$withDefaults()`.

### `$withDefaults()`: explicit materialization

```js
const tree = new ObjectTree({ name: 'job' }, schema)
const filled = tree.$withDefaults()

filled.$value      // { name: 'job', retries: 3 }   ← raw now contains the default
filled !== tree    // true — returns a new ObjectTree
tree.$value        // { name: 'job' }              ← original tree unchanged
```

`$withDefaults()`:
- Returns a **new** `ObjectTree` over a cloned data object — the original is untouched.
- Recursively applies defaults through nested `properties` and `items` (object items only).
- Object-typed defaults are deep-cloned (`structuredClone`), so each instance gets its own copy.
- Existing values are preserved — defaults fill gaps, never overwrite.

### Cross-`$ref` defaults (v0.6.1)

When a property points to a schema in another document, default-application must resolve nested `$ref`s with the **resolved sub-loader**, not the parent loader. v0.6.0 reused the parent loader and could miss defaults whose siblings used relative `$ref`s into the resolved scope. v0.6.1 forwards the sub-loader returned by `loader.resolve(...)` through the recursion, so cross-document defaults now apply correctly.

If you maintain code that constructs trees against multi-file schemas (e.g. `definitions.json#/definitions/Rule`) and relied on `$withDefaults()` filling cross-file defaults, you should be on v0.6.1.

### Quick rules

- Reading a missing key with a `default` returns the default **without** mutating raw data.
- `Object.keys(tree)` and `key in tree` include default-only keys.
- Invalid defaults throw at `new ObjectTree(...)` construction time.
- Use `$withDefaults()` only when you need the merged data committed (export, persist, hand off raw).
- Each `$withDefaults()` call returns a fresh tree — re-apply if you mutate and need a clean snapshot.

## Common Mistakes

### Wrong: Build your own Loader when root Loader already has everything

```js
// DON'T
const full = JSON.parse(readFileSync('schema.json', 'utf-8'))
const myLoader = new Loader(full, dirname(path))
```

```js
// DO
const { node, loader: subLoader } = rootLoader.resolve('schema.json#/definitions/MyType')
```

### Wrong: Store raw JSON, bypass ObjectTree

```js
// DON'T — no validation, no defaults, no dot key
const raw = JSON.parse(readFileSync(file, 'utf-8'))
cache.set(raw.name, raw)
```

```js
// DO — ObjectTree handles everything
const obj = new ObjectTree({}, schema, subLoader)
for (const [k, v] of Object.entries(data)) obj[k] = v
cache.set(obj.name, obj)
```

### Wrong: Unflatten dot keys yourself

```js
// DON'T — reinventing what Proxy set already does
function unflattenDotKeys(obj) { ... }
const expanded = unflattenDotKeys(data)
```

```js
// DO — Proxy set handles dot keys natively
for (const [k, v] of Object.entries(data)) tree[k] = v
```

### Wrong: Compose synthetic schemas, lose $ref scope

```js
// DON'T — # points to your synthetic object, not the original document
const schema = { type: 'object', properties: def.properties, definitions: full.definitions }
const obj = new ObjectTree({}, schema, rootLoader) // $ref "#/definitions/X" fails
```

```js
// DO — use sub-loader, it knows the correct # scope
const { node, loader: subLoader } = rootLoader.resolve('schema.json#/definitions/MyType')
const obj = new ObjectTree({}, node, subLoader)
```

### Implementation: Loading Flat JSON with Dot Keys

```js
// ✅ CORRECT: Dual-mode initialization pattern
const { node, loader } = rootLoader.resolve('#/definitions/Rule')
const schema = { type: 'object', properties: node.properties }
const tree = new ObjectTree({}, schema, loader)

for (const [k, v] of Object.entries(data)) tree[k] = v
// "match.field.name": "value" → { match: { field: { name: "value" } } }
```

**Why strip `required` and `additionalProperties`:**

1. **Empty init** — start with `{}`, no required fields needed
2. **Dot key acceptance** — allow keys not in schema (will be expanded)
3. **Proxy set expansion** — converts dot keys to nested structure
4. **Validation happens per-property** — each set validates against sub-schema

**Design insight**: flat mode for input (authoring), nested mode for runtime (validation + access). ObjectTree bridges both worlds.

**Alternative: Complete data initialization**

```js
// ✅ For pre-validated, complete data
const { node, loader } = rootLoader.resolve('#/definitions/Rule')
const tree = new ObjectTree(completeData, node, loader)
// All required fields enforced, no additionalProperties accepted
```

### Wrong: Use validate() for data matching

```js
// DON'T — validate treats data as Draft-07 schema, matches everything
validate(cmd, rule.matchData)  // {name:{text:"rm"}} has no const/type → always valid
```

```js
// DO — use deep subset match for data-to-data comparison
_deepMatch(cmd, rule.matchData)  // {name:{text:"rm"}} checks cmd.name.text === "rm"
```

Data match (deep object subset) vs schema match (JSON Schema validation) are consumed differently - don't mix them up.

## Summary

1. One root Loader at boot - loads all schemas via $ref chain
2. `resolve()` returns node + sub-loader with correct scope
3. ObjectTree = schema structure + data values
4. Dual-mode design - flat dot keys for authoring, nested objects for runtime. Proxy set auto-converts.
5. Don't store raw objects - always go through ObjectTree
6. Defaults are read lazily and validated at construction; `$withDefaults()` is the only path that materializes them into raw data
7. v0.5.1+ - Dual-mode representation enables human-friendly authoring + structured validation
8. v0.5.2+ - Observer hook receives schema context for reactive patterns
9. v0.6.1 - Cross-`$ref` defaults now resolve with the sub-loader; multi-document schemas materialize defaults correctly
