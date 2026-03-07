# mcp-arango-mind

## Identity

Schema-driven MCP server for ArangoDB.
Two JSON Schemas define the server. One runtime connects them.
Message bus (event + payload + status) connects all internals.

## Schema Stack

```
config/mcp-schema.json        ← MCP protocol (Draft-07, official)
config/arango-openapi.json    ← ArangoDB REST API (OpenAPI 3.1)
lib/schema2object.mjs         ← Runtime: schema → validated object
```

Both schemas feed into the same `ObjectTree`.
MCP schema validates the envelope. OpenAPI schema validates the payload.

## Stack

- **Runtime**: Node.js 22+ (native ESM)
- **Language**: JavaScript (.mjs), no TypeScript, no build step
- **Validation**: schema2object (JSON Schema Draft-07 as object class)
- **Middleware**: Message bus — event + payload + status
- **Transport**: JSON-RPC 2.0 over stdio + SSE
- **HTTP**: Node.js native `fetch()` (no axios, no node-fetch)
- **Schemas**: MCP spec + ArangoDB OpenAPI spec (both JSON Schema)

## Architecture

```
server.mjs      → entry: parse args → load core → attach transport
core.mjs        → createCore(): bus + pool + handle()
bus.mjs         → message bus: send(event, payload) → result
pool.mjs        → HTTP connection pool (keep-alive)
protocol.mjs    → MCP JSON-RPC: validate + route (mcp-schema.json)
dispatch.mjs    → OpenAPI → HTTP engine (arango-openapi.json)
log.mjs         → bus subscriber: debug (stderr) + audit (JSONL file)
transports/
  stdio.mjs     → stdin/stdout adapter (~20 lines)
  sse.mjs       → HTTP server + SSE streaming (~40 lines)
```

Config:
```
config/mcp-schema.json         → MCP protocol definitions (83 defs)
config/arango-openapi.json     → ArangoDB operations (253 ops)
config/profiles.json           → connection profiles (url, auth, db)
lib/schema2object.mjs          → validation runtime (484 lines)
```

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
- MCP schema is the source of truth for protocol messages
- OpenAPI spec is the source of truth for ArangoDB operations
- schema2object is the single validation runtime for both
- Tool definitions generated from OpenAPI spec at startup
- Input validation via `new ObjectTree(args, schema)`
- NEVER hand-write what a schema already defines

### Message Bus
- All internal communication goes through `bus.send(event, payload)`
- Handlers registered via `bus.handle(event, fn)`
- Handler receives payload, returns result — payload in, payload out
- Status tracking is automatic — no manual status management
- Log subscriber observes all messages via the bus

### Code Style
- Pure ESM (.mjs), no CommonJS require()
- Functions + closures over classes (Bus is the one exception)
- No external npm dependencies (schema2object bundled in lib/)
- Max 300 lines per .mjs file
- snake_case for tool names, camelCase for JS variables

### What NOT to do
- NEVER use Zod (schema2object replaces it)
- NEVER use arangojs or python-arango (OpenAPI spec replaces them)
- NEVER use MCP SDK's McpServer class (we use mcp-schema.json directly)
- NEVER use Node.js EventEmitter for pipeline flow (use bus.send)
- NEVER add TypeScript or a build step
- NEVER hand-write a handler for standard ArangoDB operations
- NEVER modify config files without permission
- NEVER add npm dependencies without discussion

### MCP Protocol
- Use `config/mcp-schema.json` definitions for message validation
- `ObjectTree(msg, schema.$defs.CallToolRequest)` to validate incoming
- `ObjectTree(result, schema.$defs.CallToolResult)` to construct outgoing
- Only implement: initialize, tools/list, tools/call, ping, notifications

### Testing
- Node.js built-in test runner (`node --test`)
- Test files: `tests/*.test.mjs`
- Mock HTTP responses, not ArangoDB
- Test bus handlers independently (payload in → result out)

### Git
- `git add -A` for commits
- Imperative commit messages, no emoji
- Checkpoint commit after each sub-task

## Tool Naming

OpenAPI path → MCP tool name:

```
/_api/collection/{name}           → collection_get (GET)
/_api/collection                  → collection_create (POST)
/_api/document/{collection}/{key} → document_read (GET)
/_api/cursor                      → cursor_create (POST)
```

Strip `/_db/{database-name}` and `/_api/` prefix.

## Connection

Profiles in `config/profiles.json`. Per-tool `database` argument
overrides profile default. Profile switch = new base URL + auth.

## Key Files

| File | Purpose |
|------|---------|
| ARCHITECTURE.md | Full architecture + design decisions |
| server.mjs | Entry point: args → core → transport |
| core.mjs | createCore(): wire bus + pool + handlers |
| bus.mjs | Message bus: event + payload + status |
| pool.mjs | HTTP connection pool (keep-alive) |
| protocol.mjs | MCP JSON-RPC handler (schema-validated) |
| dispatch.mjs | OpenAPI → HTTP engine |
| log.mjs | Bus subscriber: debug + audit |
| transports/stdio.mjs | stdin/stdout transport |
| transports/sse.mjs | HTTP/SSE transport |
| lib/schema2object.mjs | Validation runtime |
| config/mcp-schema.json | MCP protocol schema (official) |
| config/arango-openapi.json | ArangoDB API spec (253 ops) |
| config/profiles.json | Connection config |
