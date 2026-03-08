# Changelog

## [0.1.0] - 2026-03-08

### Added

- Schema-driven MCP server for ArangoDB — no hand-written tool definitions
- 246 operations from ArangoDB OpenAPI spec (3.12.8), grouped into 23 category tools
- Connection tools: `getConfig`, `setDatabase`, `setAuth` — defined in `arango-connection.json`
- Community spec generator (`scripts/gen-community-spec.mjs`) — strips enterprise-only ops
- `--enterprise` flag to switch back to full 253-operation spec
- arangojs-compatible connection layer: pool queue, retry, failover, load balancing, auth
- Transport: stdio (MCP clients) + SSE (HTTP/web clients)
- Request correlation: per-request ID across all bus events
- Schema-driven log levels: `silent`, `info`, `debug` — configured via `arango-connection.json`
- MCP Resources: `tool://categories`, `tool://help/<toolName>`
- Three-layer tool discovery: tools/list → category → per-tool help resource
- 52 tests covering protocol, dispatch, connection, schema conformance
- GitHub Actions CI: Node.js 22 + 24, syntax check, file size limits, smoke test
