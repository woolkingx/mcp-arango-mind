# mcp-arango-mind

## Identity

Schema-driven MCP server for ArangoDB.
Three JSON schemas define the server. One runtime connects them.
Message bus (event + payload + status) connects all internals.

## Schema Stack

```
config/mcp-schema.json           ← MCP protocol (Draft-07, official, DO NOT MODIFY)
config/arango-openapi.json       ← ArangoDB REST API (OpenAPI 3.1, official, DO NOT MODIFY)
config/arango-connection.json    ← Connection config schema (ported from arangojs types)
config/profiles.json             ← Runtime connection profiles (url, auth, db)
lib/schema2object.mjs            ← Runtime: schema → object class (ObjectTree)
```

Both protocol schemas feed into the same `ObjectTree`.
MCP schema defines the envelope class. OpenAPI schema defines the payload class.
Connection schema defines config class + provides defaults.

## Architecture

arangojs 20K lines = TypeScript types + JSDoc + HTTP wrappers.
Our replacement = JSON Schema + schema2object + functions.

```
Layer 1+2 (transport):  connection.mjs ← ported from arangojs connection.ts
                         errors.mjs     ← ported from arangojs errors.ts
Layer 3 (operations):   OpenAPI spec auto-covers all 252+ operations
                         dispatch.mjs reads spec, no hand-written handlers
```

### File Layout

```
server.mjs       → entry: parse args → load core → attach transport
core.mjs         → createCore(): bus + connection + dispatch + protocol
bus.mjs          → message bus: send(event, payload) → result
connection.mjs   → transport: queue, retry, failover, auth (from arangojs)
errors.mjs       → error hierarchy: ArangoError, NetworkError, etc.
env.mjs          → .env loading, profile resolution, saveEnv() persist
protocol.mjs     → MCP JSON-RPC: validate + route
dispatch.mjs     → OpenAPI → category tools + HTTP dispatch engine
log.mjs          → bus subscriber: debug (stderr) + audit (JSONL file)
transports/
  stdio.mjs      → stdin/stdout adapter
  sse.mjs        → HTTP server + SSE streaming
```

### Connection Layer (from arangojs)

Ported from arangojs connection.ts. Pure transport — no business logic.

| feature | source |
|---------|--------|
| Pool queue (poolSize slots) | connection.ts _runQueue |
| Retry on network error (maxRetries) | connection.ts request loop |
| Write-write conflict retry (retryOnConflict) | connection.ts errorNum 1200 |
| Host failover + leader redirect | connection.ts 503 + x-arango-endpoint |
| Load balancing (NONE/ONE_RANDOM/ROUND_ROBIN) | connection.ts host selection |
| Queue time metrics | connection.ts x-arango-queue-time-seconds |
| setDatabase() / setAuth() / setTransactionId() | arangojs Database + Connection API |

Config validated via `ObjectTree` + `arango-connection.json` schema. Schema provides all defaults.

### Default Priority Chain

```
.env  >  profiles.json  >  arango-connection.json schema defaults
```

`env.mjs` loads `.env` → merges into `process.env` → `resolveProfile()` merges env over profile.
`connection.mjs` applies schema defaults via `ObjectTree.withDefaults()`.
`saveEnv()` persists runtime changes (setDatabase/setAuth) back to `.env`.

### Tool Pipeline

Two phases, two roles of schema:

| phase | schema role | how |
|-------|------------|-----|
| **tools/list** | JSON raw data | Read OpenAPI spec + ConnectionTools as-is → category tools |
| **tools/call** | Object class via schema2object | `new ObjectTree(args, schema)` — schema IS the class, `tree` IS the instance |

#### tools/list — JSON raw data

dispatch.mjs reads two schema sources at startup:
1. `arango-openapi.json` paths → 252 HTTP operations → grouped by tag into category tools
2. `arango-connection.json` `ConnectionTools` definition → `Connection` category tool (getConfig, setDatabase, setAuth) → injected into operations Map with `handler: 'local'`

MUST read raw JSON — NEVER hardcode tool names, descriptions, or enums in code.

#### ConnectionTools — local handler operations

`arango-connection.json#/definitions/ConnectionTools` defines the `Connection` category tool.
These operations control the client connection layer, not ArangoDB REST endpoints.
dispatch.mjs reads `ConnectionTools.actions[]` at startup → registers each as a local operation:

```js
// dispatch reads ConnectionTools.actions → injects into operations Map
for (const action of ct.actions || []) {
  operations.set(action.name, { handler: 'local', tags: [ct.categoryName], inputSchema: action.inputSchema, ... })
}
// Result: getConfig, setDatabase, setAuth each become entries with handler: 'local'
```

`core.mjs` provides `localHandlers` map → passed to `createDispatch()` → called at dispatch time.
`handler: 'local'` on an operations Map entry → routes to `localHandlers[name](args)` instead of HTTP.

#### tools/call — schema2object as object class

schema2object is NOT a validation library. JSON Schema IS the object class definition.
`ObjectTree` is the runtime instance. Properties defined in schema become getters/setters on the instance.

```js
const tree = new ObjectTree(data, schema)  // schema defines the class, tree is the instance
tree['collection-name']   // getter — type/enum/format enforced by schema
tree['collection-name'] = x  // setter — validates against schema on assignment
tree.withDefaults()       // apply schema defaults → new ObjectTree instance
tree.toDict()             // only schema-defined properties → plain object (drops additionalProperties)
tree.schema               // schema definition as plain object
tree[key]                 // property access, not dict lookup — use this, not toDict()[key]
```

**toDict() drops additionalProperties** — only returns keys defined in `schema.properties`.
When you need ALL keys (including extra body fields), access `tree[key]` for schema-defined ones
and iterate original `input` object for the rest.

`database-name` path param: inject from `conn.getDatabase()` into `input` BEFORE constructing
ObjectTree, so required constraint is satisfied without schema surgery.

## Message Bus

Internal middleware is message-based, not EventEmitter-based.

A message = `{ id, event, status, payload, ts }`.
- `await bus.send(event, payload)` → pipeline step (sequential, returns result)
- `bus.send(event, payload)` without await → observation (fire-and-forget)
- `Promise.all([bus.send(...), bus.send(...)])` → parallel

Status lifecycle: `pending → processing → completed | failed | timeout`

Payloads are plain JSON objects → schema-validatable via ObjectTree.

## Rules

### Schema-Driven Development

| rule | trigger | action | why |
|------|---------|--------|-----|
| Schema is source of truth | Adding any definition (tool, config, validation) | Read from existing JSON schema, NEVER hardcode in .mjs | Schemas already define it — code reads, never duplicates |
| OpenAPI spec = ArangoDB operations | Need ArangoDB tool definition | dispatch.mjs reads spec at startup | 252 ops auto-covered, zero hand-written handlers |
| Connection schema = config | Need connection defaults/validation | ObjectTree + arango-connection.json | arangojs types ported to JSON Schema |
| ConnectionTools = local ops | Need getConfig/setDatabase/setAuth tool | Read `arango-connection.json#/definitions/ConnectionTools` | Schema defines the tool — dispatch registers it as `handler: 'local'` |
| schema2object = object class | Need typed instance from data | `new ObjectTree(data, schema)` — access via `tree[key]`, not dict | Schema IS the class; instance enforces constraints on get/set |
| Official specs are READ-ONLY | Tempted to edit arango-openapi.json or mcp-schema.json | MUST NOT modify — they are upstream official specs | Changes would be overwritten on spec update |

### Code Style
- Pure ESM (.mjs), no CommonJS require()
- Functions + closures over classes (Bus is the one exception)
- No external npm dependencies (schema2object bundled in lib/)
- Max 300 lines per .mjs file
- snake_case for tool names, camelCase for JS variables

### What MUST NOT Do

| rule | why |
|------|-----|
| NEVER use Zod/Joi | schema2object replaces them |
| NEVER use arangojs or python-arango | OpenAPI spec + connection.mjs replaces them |
| NEVER use MCP SDK McpServer class | mcp-schema.json used directly |
| NEVER use EventEmitter for pipeline | bus.send is the middleware |
| NEVER add TypeScript or build step | Pure ESM, no compilation |
| NEVER hand-write ArangoDB operation handlers | OpenAPI spec auto-generates them |
| NEVER modify official config files without permission | arango-openapi.json, mcp-schema.json are upstream |
| NEVER add npm dependencies without discussion | Zero-dependency design |
| NEVER hardcode JSON schema properties in code | Read from .json files |
| NEVER invent new tools — use existing OpenAPI operations or ConnectionTools | 252 ArangoDB ops + 3 connection ops cover everything |
| NEVER use toDict() as data source for decompose | toDict() drops additionalProperties — use tree[key] for schema props, raw input for extras |
| NEVER call new ObjectTree() just to validate then discard | ObjectTree IS the instance — keep it, access properties through it |
| NEVER remove required from inputSchema to avoid validation errors | Inject missing defaults into input BEFORE constructing ObjectTree |

### MCP Protocol
- Use `config/mcp-schema.json` definitions for message validation
- `ObjectTree(msg, schema.$defs.CallToolRequest)` to validate incoming
- `ObjectTree(result, schema.$defs.CallToolResult)` to construct outgoing
- Only implement: initialize, tools/list, tools/call, resources/list, resources/read, ping, notifications

### Testing
- Node.js built-in test runner (`node --test`)
- Test files: `tests/*.test.mjs`
- Mock HTTP responses, not ArangoDB
- Test bus handlers independently (payload in → result out)

### Git
- `git add -A` for commits
- Imperative commit messages, no emoji
- Checkpoint commit after each sub-task

## Key Files

| File | Purpose |
|------|---------|
| server.mjs | Entry point: args → core → transport |
| core.mjs | createCore(): wire bus + connection + dispatch + protocol |
| bus.mjs | Message bus: event + payload + status |
| connection.mjs | Transport: queue, retry, failover, auth (from arangojs) |
| errors.mjs | Error hierarchy (ArangoError, NetworkError, etc.) |
| env.mjs | .env load, profile resolution, saveEnv() persist |
| protocol.mjs | MCP JSON-RPC handler (validate + route) |
| dispatch.mjs | OpenAPI → category tools + HTTP dispatch engine |
| log.mjs | Bus subscriber: debug + audit |
| transports/stdio.mjs | stdin/stdout transport |
| transports/sse.mjs | HTTP/SSE transport |
| lib/schema2object.mjs | Object class runtime (ObjectTree) |
| config/mcp-schema.json | MCP protocol schema (official, READ-ONLY) |
| config/arango-openapi.json | ArangoDB API spec (official, READ-ONLY) |
| config/arango-connection.json | Connection config schema + `ConnectionTools` local op definitions |
| config/profiles.json | Connection profiles |
