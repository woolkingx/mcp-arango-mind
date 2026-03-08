# mcp-arango-mind

Schema-driven [Model Context Protocol](https://modelcontextprotocol.io/) server for [ArangoDB](https://arangodb.com/). Zero npm dependencies.

Exposes all ArangoDB REST API operations as MCP tools — 23 category tools generated at startup from the OpenAPI spec (252 operations grouped by domain). No hand-written tool definitions; add a new ArangoDB endpoint to the spec and it becomes a tool automatically.

## Architecture

Three JSON schemas drive the entire server:

```
mcp-schema.json        → Protocol layer (JSON-RPC validation)
arango-openapi.json    → Dispatch layer (252 operations → 22 category tools)
arango-connection.json → Transport layer (connection config, retry, auth)
```

```
Client ──stdin/SSE──▶ Protocol ──bus──▶ Dispatch ──bus──▶ Connection ──HTTP──▶ ArangoDB
                      (validate,        (tool→REST        (queue, retry,
                       route)            mapping)          failover, auth)
```

Core modules:

| File | Lines | Role |
|------|-------|------|
| `bus.mjs` | 45 | Message bus with request correlation |
| `protocol.mjs` | 122 | MCP JSON-RPC handler |
| `dispatch.mjs` | 297 | OpenAPI + ConnectionTools → category tools + HTTP dispatch |
| `connection.mjs` | 188 | Connection pool, retry, failover, auth |
| `errors.mjs` | 98 | Typed error hierarchy (ArangoError, HttpError, NetworkError) |
| `log.mjs` | 58 | Per-request summary + per-event debug logging |
| `env.mjs` | 103 | `.env` loader + config cascade |
| `core.mjs` | 73 | Assembly: wire all components + Connection local handlers |
| `server.mjs` | 56 | CLI entry: parse args, load schemas, start transport |
| `lib/schema2object.mjs` | 487 | JSON Schema → object class runtime (ObjectTree) |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/your-org/mcp-arango-mind.git
cd mcp-arango-mind

# 2. Configure
cp .env.example .env
# Edit .env with your ArangoDB connection details

# 3. Run (stdio transport — for MCP clients)
node server.mjs

# 4. Run (HTTP transport — for web clients)
node server.mjs --sse --port 8000
```

No `npm install` needed. The project uses only Node.js built-in modules.

## Configuration

### Config Cascade

Priority (highest wins):

1. **CLI flags** — `--debug` forces `logLevel: debug`
2. **Environment variables** — `ARANGO_URL`, `ARANGO_DB`, etc.
3. **`.env` file** — loaded at startup
4. **`config/profiles.json`** — named profiles
5. **`config/arango-connection.json`** — schema defaults

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARANGO_URL` | `http://127.0.0.1:8529` | ArangoDB server URL |
| `ARANGO_DB` | `_system` | Database name |
| `ARANGO_USERNAME` | `root` | Basic auth username |
| `ARANGO_PASSWORD` | *(empty)* | Basic auth password |
| `ARANGO_TOKEN` | — | Bearer token (overrides username/password) |
| `ARANGO_LOG_LEVEL` | `info` | Logging: `silent`, `info`, `debug` |

### CLI Flags

```
--profile <name>    Select profile from config/profiles.json (default: "local")
--debug             Force log level to debug
--sse               Use HTTP transport instead of stdio
--port <number>     HTTP port (default: 8000)
--host <address>    HTTP bind address (default: 127.0.0.1)
--audit <file>      Write structured JSON audit log to file
--enterprise        Use full spec (arango-openapi.json) instead of community spec
```

### Connection Options

All options defined in `config/arango-connection.json` with JSON Schema defaults:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string \| string[] | `http://127.0.0.1:8529` | Server URL(s) |
| `database` | string | `_system` | Database name |
| `auth` | object | `{username:"root",password:""}` | Credentials |
| `poolSize` | integer | `3` | Max concurrent requests |
| `timeout` | integer | `0` | Request timeout ms (0 = none) |
| `maxRetries` | integer | `0` | Retries on network error |
| `retryOnConflict` | integer | `0` | Retries on write-write conflict |
| `loadBalancing` | string | `NONE` | `NONE`, `ONE_RANDOM`, `ROUND_ROBIN` |
| `logLevel` | string | `info` | `silent`, `info`, `debug` |

## Logging

Three levels:

- **`silent`** — no stderr output
- **`info`** — one summary line per request:
  ```
  req_1 tools/call listCollections → 126ms [validate:1ms dispatch:122ms route:124ms]
  ```
- **`debug`** — per-event verbose + summary:
  ```
  [2026-03-08T03:48:26.186Z][req_1][validate] completed 0ms
  [2026-03-08T03:48:26.192Z][req_1][dispatch] completed 121ms
  [2026-03-08T03:48:26.192Z][req_1][route] completed 121ms
  req_1 tools/call getVersion → 127ms [validate:5ms dispatch:121ms route:121ms]
  ```

Audit log (`--audit <file>`) writes structured JSON per event regardless of log level.

## MCP Resources

Beyond tools, the server exposes discoverable resources:

| URI | Description |
|-----|-------------|
| `tool://categories` | All 23 tool categories with tool counts |
| `tool://help/<toolName>` | Per-tool help: parameters, HTTP method, path |

## Testing

```bash
# All tests (unit + integration)
npm test

# Integration tests require a running ArangoDB instance.
# Configure via .env or environment variables.
# Tests skip gracefully if ARANGO_URL is not set.
```

## Project Constraints

- Zero npm dependencies — Node.js built-ins only
- Every source file under 300 lines (enforced by CI)
- All defaults from JSON Schema — no hardcoded values in code
- Node.js 22+

## License

MIT
