# mcp-arango-mind — Architecture

## Philosophy

**Schema IS the code.** Two JSON Schemas define the server.
**Core IS the server.** Transports are interchangeable thin wrappers.
**Event + Payload IS the middleware.** Messages flow, not function calls.

## Schema Stack

```
config/mcp-schema.json          MCP protocol (Draft-07, 2,139 lines, 83 defs)
config/arango-openapi.json      ArangoDB REST API (OpenAPI 3.1, 33,760 lines, 253 ops)
lib/schema2object.mjs           Runtime: schema → validated object (484 lines)
```

| Schema | Defines | Used For |
|--------|---------|----------|
| MCP schema | JSON-RPC message shapes | Validate incoming, construct outgoing |
| OpenAPI spec | ArangoDB operations | Generate tools, validate args, build HTTP |
| schema2object | Draft-07 as object methods | Runtime engine for both schemas |

## Core + Transport Architecture

Core is the server. Transports are interfaces.

```
┌──────────┐  ┌───────────┐
│  stdio   │  │    SSE    │   ← transport interfaces (thin wrappers)
│  ~20 loc │  │   ~40 loc │
└────┬─────┘  └─────┬─────┘
     │               │
     └───────┬───────┘
             │
      ┌──────┴──────┐
      │    CORE     │
      │             │
      │  bus        │  event + payload message system
      │  pool       │  HTTP keep-alive to ArangoDB
      │  protocol   │  MCP JSON-RPC (schema-validated)
      │  dispatch   │  OpenAPI → fetch()
      │  log        │  subscribes to bus messages
      │             │
      │  handle(msg) → response   (the only API)
      └─────────────┘
```

**stdio is not one-shot.** Claude Code keeps the MCP process alive — it's
a long-running process reading stdin, same lifecycle as a daemon.
The only difference from SSE is the wire format.

Both transports do the same thing:
1. Read message from wire (stdin line / HTTP request)
2. `const response = await core.handle(message)`
3. Write response to wire (stdout / SSE stream)

Core doesn't know or care which transport is calling it.

## Message Bus — Event + Payload + Status

The internal architecture is built on a single primitive: **messages**.

A message = event name + payload + status. This is async-native:
messages carry their own data, handlers receive and return payloads,
and status tracking provides full observability.

### Message Structure

```javascript
{
  id:      'msg_001',           // unique per message
  event:   'dispatch',          // intent
  status:  'pending',           // lifecycle state
  payload: { method, path, body },  // data in (JSON Schema compatible)
  ts:      1709884800000        // created at
}
```

### Status Lifecycle

```
pending → processing → completed   (normal)
pending → processing → failed      (handler threw)
pending → timeout                   (no handler / too slow)
```

### Bus API

```javascript
// Core primitive: send message, await response
const result = await bus.send('validate', payload)

// Parallel: multiple messages concurrently
const [a, b] = await Promise.all([
  bus.send('checkAuth', ctx),
  bus.send('validateSchema', ctx),
])

// Fire-and-forget: observation (don't await = traditional event)
bus.send('log', { event: 'dispatch', duration: 45 })

// Register handler
bus.handle('validate', async (payload) => {
  return new ObjectTree(payload, schema).toDict()
})
```

Same mechanism, three usage patterns — the only difference is
whether the caller `await`s.

### Schema Integration

Payloads are plain JSON objects → JSON Schema validation is natural:

| Pipeline Stage | Event | Payload Schema |
|---------------|-------|----------------|
| MCP incoming | `'request'` | `mcp-schema.json#/$defs/CallToolRequest` |
| ArangoDB call | `'dispatch'` | `arango-openapi.json` operation schema |
| MCP outgoing | `'response'` | `mcp-schema.json#/$defs/CallToolResult` |

```javascript
bus.handle('validate', (payload) => {
  return new ObjectTree(payload, mcpSchema.$defs.CallToolRequest).toDict()
})

bus.handle('dispatch', async (payload) => {
  const op = lookupOperation(payload.params.name)
  const validated = new ObjectTree(payload.params.arguments, op.schema).toDict()
  return pool.fetch(op.method, op.url, validated)
})
```

### Observability via Status

Every message has a status record. Log subscriber sees the full lifecycle:

```jsonl
{"id":"msg_001","event":"validate","status":"completed","duration":2}
{"id":"msg_002","event":"dispatch","status":"completed","duration":45}
{"id":"msg_003","event":"format","status":"failed","error":"...","duration":1}
```

No handler registered → `status: 'failed'`, error logged.
Handler too slow → `status: 'timeout'`, detectable.
No coupling between tracking and business logic.

## Core Internals

```
core.mjs
├── bus.mjs           # Message bus: send(event, payload) → result
├── pool.mjs          # HTTP connection pool (keep-alive to ArangoDB)
├── protocol.mjs      # MCP JSON-RPC: validate + route (mcp-schema.json)
├── dispatch.mjs      # OpenAPI → HTTP engine (arango-openapi.json)
└── log.mjs           # Bus subscriber: debug + audit sinks
```

### bus.mjs — Message Bus (~40 lines)

```javascript
class Bus {
  #handlers = new Map()
  #msgId = 0

  handle(event, fn) {
    this.#handlers.set(event, fn)
  }

  async send(event, payload) {
    const msg = {
      id: `msg_${++this.#msgId}`,
      event, status: 'pending', payload, ts: Date.now()
    }
    const handler = this.#handlers.get(event)
    if (!handler) {
      msg.status = 'failed'
      msg.error = `no handler: ${event}`
      this.send('log', msg)
      throw new Error(msg.error)
    }
    msg.status = 'processing'
    try {
      const result = await handler(msg.payload)
      msg.status = 'completed'
      return result
    } catch (err) {
      msg.status = 'failed'
      msg.error = err.message
      throw err
    } finally {
      msg.duration = Date.now() - msg.ts
      if (event !== 'log') this.send('log', msg)
    }
  }
}
```

### pool.mjs — Connection Pool

HTTP keep-alive connections to ArangoDB, reused across calls.

- stdio mode: pool lives for process lifetime (many tool calls per session)
- SSE mode: pool shared across all connected clients
- Profile switch: pool drains old connections, opens new base URL

```javascript
// Node.js native — no dependencies
import { Agent } from 'node:http'
const agent = new Agent({ keepAlive: true, maxSockets: 10 })
```

### protocol.mjs — MCP Protocol (Schema-Validated)

Uses MCP schema definitions (`config/mcp-schema.json`) directly:

| Method | Schema Definition | Action |
|--------|------------------|--------|
| `initialize` | InitializeRequest → InitializeResult | Server info + capabilities |
| `notifications/initialized` | InitializedNotification | Ack |
| `tools/list` | ListToolsRequest → ListToolsResult | Generated from OpenAPI |
| `tools/call` | CallToolRequest → CallToolResult | Validate → dispatch |
| `ping` | PingRequest | Pong |

Tool list generated at startup from OpenAPI spec.
Each operation → MCP `Tool` object (name, description, inputSchema).

### dispatch.mjs — Schema-to-HTTP Engine

The mapping layer between MCP tool args and ArangoDB HTTP API:

1. **Lookup**: tool_name → OpenAPI operation (path, method, parameters)
2. **Validate**: `new ObjectTree(args, paramSchema).withDefaults()`
3. **Decompose** by OpenAPI `in` field:
   - `in: path` → URL template substitution
   - `in: query` → URL search params
   - `in: header` → request headers
   - `requestBody` → JSON body
4. **Execute**: `pool.fetch(method, url, { headers, body })`
5. **Return**: response payload

### log.mjs — Dual-Sink Logger

Subscribes to bus `log` event. Routes by level.

| Level | Sink | Content |
|-------|------|---------|
| debug | stderr | message flow, timing |
| info | stderr | tool calls, profile switches |
| audit | file | all messages with status, duration |
| error | stderr + file | failed messages with stack trace |

Audit log format: JSONL (one JSON object per line, appendable).

## Data Flow (Complete)

```
Client (Claude Code / SSE client)
  │
  │  JSON-RPC message
  ▼
Transport (stdio.mjs or sse.mjs)
  │
  │  raw message
  ▼
core.handle(message)
  │
  ├─ bus.send('request', message)
  │   → log: { event:'request', status:'completed' }
  │
  ├─ bus.send('validate', message)
  │   → ObjectTree(message, mcpSchema.$defs.CallToolRequest)
  │   → log: { event:'validate', status:'completed' }
  │
  ├─ protocol.route(validated)
  │   ├─ 'initialize' → return InitializeResult
  │   ├─ 'tools/list' → return generated tool list
  │   └─ 'tools/call' → continue to dispatch
  │
  ├─ bus.send('dispatch', { tool, args })
  │   → ObjectTree(args, openApiOpSchema)
  │   → pool.fetch(method, url, body)
  │   → log: { event:'dispatch', status:'completed', duration:45 }
  │
  ├─ bus.send('format', httpResult)
  │   → ObjectTree(result, mcpSchema.$defs.CallToolResult)
  │   → log: { event:'format', status:'completed' }
  │
  └─ return jsonRpcResponse
  │
  ▼
Transport: write response to wire
```

If any `bus.send()` fails → `status:'failed'` logged, error propagates
up to `handle()`, which returns a JSON-RPC error response.

## File Structure

```
mcp-arango-mind/
├── server.mjs              # Entry: parse args → load core → attach transport
├── core.mjs                # createCore(config): bus + handle()
├── bus.mjs                 # Message bus: event + payload + status (~40 lines)
├── pool.mjs                # HTTP connection pool (node:http Agent)
├── protocol.mjs            # MCP JSON-RPC (schema-validated)
├── dispatch.mjs            # OpenAPI → HTTP engine
├── log.mjs                 # Bus subscriber: debug + audit sinks
├── transports/
│   ├── stdio.mjs           # stdin/stdout adapter (~20 lines)
│   └── sse.mjs             # HTTP server + SSE streaming (~40 lines)
├── lib/
│   └── schema2object.mjs   # Validation runtime (484 lines)
├── config/
│   ├── mcp-schema.json     # MCP protocol schema (official)
│   ├── arango-openapi.json # ArangoDB API spec (253 ops)
│   └── profiles.json       # Connection profiles
├── ARCHITECTURE.md
├── .claude/CLAUDE.md
├── package.json
└── tests/
    ├── bus.test.mjs
    ├── core.test.mjs
    ├── protocol.test.mjs
    └── dispatch.test.mjs
```

## Design Decisions

### Event + Payload + Status (not traditional EventEmitter)

Traditional EventEmitter is fire-and-forget with no return value.
Traditional function calls are synchronous-minded with async bolted on.

Our bus is neither. A message carries its data (payload), has a handler
that returns a result, and tracks its own lifecycle (status).
This is async-native: the message is the unit of work.

- `await bus.send()` = pipeline step (sequential, with return value)
- `bus.send()` without await = observation (fire-and-forget)
- `Promise.all([bus.send(), bus.send()])` = parallel

One mechanism, three patterns.

### Payload = JSON = Schema-validatable

Payloads are plain objects. JSON Schema validates them via ObjectTree.
No special context objects, no middleware state, no req/res pattern.
Payload in, payload out. Schema is the contract.

### Core + Transport separation

Core exposes one function: `handle(msg) → response`.
Transport reads from wire, calls handle, writes to wire.

This means:
- Testing core without any I/O (pure function tests)
- Adding new transports (WebSocket, IPC) = ~20 lines each
- stdio and SSE are equally first-class

### Connection pool in core, not in transport

Pool lives in core because:
- stdio process is long-running (Claude Code keeps it alive)
- Multiple tool calls in one session reuse connections
- SSE daemon shares pool across clients
- Profile switch = pool reconfiguration, transport-agnostic

### Why not MCP SDK?

MCP SDK's McpServer is Zod-centric (JSON Schema → Zod → JSON Schema round-trip).
We use the official MCP JSON Schema directly with schema2object.
Transport layer is ~20 lines — no need for SDK's 900+ line machinery.

### Why not arangojs / python-arango?

Driver libraries wrap HTTP calls with typed APIs.
OpenAPI spec describes the same HTTP calls as JSON Schema.
253 operations × 0 lines vs arangojs 20,000 lines.

### Why .mjs?

- schema2object is pure ESM
- JSON Schema = runtime validation (TypeScript = compile-time only)
- Zero build step: `node server.mjs`
- Node 22+ native ESM

### MCP Schema Version

Using `2025-03-26` (stable, Draft-07). Covers tools/list, tools/call, initialize.

### Tool Naming

```
GET  /_api/collection/{name}           → collection_get
POST /_api/collection                  → collection_create
GET  /_api/document/{collection}/{key} → document_read
POST /_api/cursor                      → cursor_create
```

Strip `/_db/{database-name}` (from profile) and `/_api/` prefix.

### Connection Profiles

```json
{
  "default": "local",
  "profiles": {
    "local": {
      "url": "http://localhost:8529",
      "database": "_system",
      "auth": { "username": "root", "password": "" }
    }
  }
}
```

## Constraints

- **No npm dependencies** — schema2object bundled, Node.js built-ins only
- **No build step** — `node server.mjs`
- **No Zod, no TypeScript, no bundler**
- **File size**: max 300 lines per .mjs
- **Core logic total**: < 400 lines
- **Transport**: < 50 lines each

## Future: Custom Operations (Phase 2)

```
custom/
├── schemas/           # JSON Schema for custom tool inputs
├── sync.mjs           # register handler on bus
├── optimize.mjs
└── embedding.mjs
```

Custom ops register handlers on the same bus.
Same message tracking, same logging, same audit trail.
