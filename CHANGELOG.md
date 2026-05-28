# Changelog

## [0.3.0] - 2026-05-28

### Added

- `mcp.help` tool for schema-owned action help, including event-shaped examples and per-action payload schemas.
- Direct category action surfaces for database, collection, view, graph, and admin tools.
- `$defs.actions` and `$defs.payloads` tool schema structure for integrated action help without `x-*` metadata.

### Changed

- `tools/list` descriptions are now compressed action indexes shaped like real calls, for example `mcp.tool.collection(action=insert, payload={...})`.
- Category tool schemas now expose concrete async-style actions such as `insert`, `find`, `aql_query`, and `create_index` instead of generic `call/target` category wrappers.
- Runtime dispatch reads schema-owned action definitions and delegates to category owners for validation and execution.
- Handbook and README now document `mcp.help`, direct category actions, and schema-owned help projection.

### Removed

- Removed `x-tools` / `x-tool` metadata from tool schemas in favor of first-class `$defs` schema nodes.

## [0.2.0] - 2026-05-24

### Added

- Schema-driven MCP server for ArangoDB with zero npm dependencies.
- Official MCP schema `2025-11-25` under `mcp/schema/mcp.schema.json`.
- Tool activation from `tools/schema/tools.schema.json`.
- Runtime tool owners: `mcp.mcp`, `mcp.arango`, `mcp.tool.template`, `mcp.tool.database`, `mcp.tool.collection`, `mcp.tool.view`, `mcp.tool.graph`, `mcp.tool.admin`, and `mcp.tool.atlas`.
- ArangoDB OpenAPI runtime under `arango/schema/arango.openapi.schema.json`.
- Generic ArangoDB OpenAPI `search`, `describe`, and `exec` flow through `mcp.arango`.
- Whitelisted `mcp.tool.*` category owners over ArangoDB OpenAPI tags.
- Template catalog lifecycle and AQL execution through `mcp.tool.template`.
- Read-only handbook atlas projections over notes, edges, topology, and readiness hints.
- ArangoDB connection layer: pool queue, retry, failover, load balancing, auth, stdio and SSE transports.
- Leveled logging: `silent`, `error`, `warn`, `info`, `debug`, `trace`, plus structured audit JSONL.
- Live ArangoDB gates for connection behavior and collection CRUD schema enforcement.
- GitHub Actions CI for Node.js 22 and 24, syntax checks, file-size checks, and MCP stdio smoke tests.

### Changed

- Architecture truth lives in `docs/handbook/index.html`; `README.md` is the public quickstart.
- MCP `serverInfo.version` is projected from `package.json`.
- Large ArangoDB API catalogs stay behind search/describe/exec instead of one MCP tool per operation.

## [0.1.0] - 2026-03-08

### Added

- Transitional schema-driven MCP server for ArangoDB.
