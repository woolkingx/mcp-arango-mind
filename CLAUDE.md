# mcp-arango-mind Master Worktree

This file is the local boot card for the `master` worktree. It is not the architecture handbook.

## Worktree Role

- `master/` is the development source of truth.
- `release/` is the published remote-synced line.
- `async/` is the currently used older implementation line and may contain unrelated dirty work.
- Do not edit `release/` or `async/` while working on `master/` unless the user explicitly redirects the target.

## Source Of Truth

Read in this order before changing behavior:

1. `docs/handbook/index.html`
2. `docs/plan/*.md`
3. `mcp/schema/*.json`, `tools/schema/*.json`, `arango/schema/*.json`, `config/*.json`
4. `src/**/*.mjs`
5. `tests/*.test.mjs`

The handbook owns architecture, boundaries, acceptance gates, and known risks. `README.md` is a public quick entrypoint only.

## Current Status

- Date: 2026-05-23.
- Current runtime tools: `mcp.mcp`, `mcp.arango`, `mcp.tool.template`, `mcp.tool.database`, `mcp.tool.collection`, `mcp.tool.view`, `mcp.tool.graph`, `mcp.tool.admin`, `mcp.tool.atlas`.
- Current master topology: MCP interface -> current tool runtime -> ArangoDB API owner.
- Handbook target topology: MCP interface -> surface root -> tool owners -> ArangoDB API owner.
- Target MCP-visible surfaces are documented as `mcp.mcp`, `mcp.arango`, and `mcp.tool.*`.
- Tool categories are documented as `mcp.tool.database`, `mcp.tool.collection`, `mcp.tool.view`, `mcp.tool.graph`, `mcp.tool.admin`, `mcp.tool.template`, and `mcp.tool.atlas`.
- Target surface split (`mcp.mcp`, `mcp.arango`, `mcp.tool.*`) is fully landed across schema, runtime, tests, and docs.
- Five `mcp.tool.*` category owners share `src/tool-category-owner.mjs` with per-category OpenAPI tag whitelists; template and atlas keep dedicated handlers.

## Next Work

The target surface taxonomy is now realised. Pending items live in handbook risk and roadmap chapters:

1. Live ArangoDB integration tests per `mcp.tool.<cat>` owner (env-gated under `ARANGO_URL`).
2. Mature template catalog (port more async templates as needed).
3. Decide on `mcp.tool.admin` scope expansion (currently 4 tags; Replication/Cluster/Users/etc. wait for explicit need).

## Local Invariants

- Keep runtime code dependency-free; `package.json` has no production dependencies.
- MCP API data is owned by `mcp/schema/mcp.schema.json`: JSON-RPC request/response shapes, capabilities, tools, resources, and content envelopes.
- MCP runtime is a pure interface/operator layer. It owns no ArangoDB API data, no tool payload truth, no environment state, and no custom tool transition truth.
- JSON Schema and OpenAPI files define API shapes only. They do not own business/domain transitions.
- Each data node has one data owner: API schema, tool owner schema, connection config, profile config, environment projection, runtime request, response formatting, or future custom domain state.
- Tool activation is schema-tree reachability from `tools/schema/tools.schema.json`; a minimal API tool is still a tool owner.
- `src/core.mjs` owns assembly; transports call `core.handle(message)`.
- `src/protocol.mjs` owns MCP JSON-RPC routing and output formatting.
- `src/tools.mjs` owns active tool schema projection and tool calls.
- `src/arango-api.mjs` owns OpenAPI operation discovery and ArangoDB HTTP request construction.
- `src/connection.mjs` owns ArangoDB transport, auth, retry, failover, and queueing.
- Tests are proof gates; do not claim completion without running the relevant gate.

## Forbidden Drift

- Do not move architecture truth back into `README.md`.
- Do not let the MCP runtime/interface become a data owner beyond the MCP API shapes declared in `mcp/schema/mcp.schema.json`.
- Do not hide data-owner decisions inside protocol, tools, or Arango API handlers.
- Do not hand-edit generated OpenAPI specs unless the task explicitly targets spec generation.
- Do not treat `async/` behavior as `master/` truth without reading both sides and naming the boundary.
- Do not push from `master/`; release publishing happens from `release/` after explicit user confirmation.

## Current Decisions

- 2026-05-23: `mcp.tool.template` activates with `list`/`search`/`describe`/`call` and `payload.target` = `<category>.<name>` for execute or `meta.create|meta.update|meta.remove|meta.validate` for catalog ops; catalog source is `config/templates/*.json`; execute dispatches `createAqlQueryCursor`.
- 2026-05-23: Five `mcp.tool.*` category owners activate via `createCategoryOwnerHandlers(arangoApi, {name, tags})`; whitelist is built from OpenAPI tag intersection; `payload.target` = operationId is gated by the whitelist before dispatch.
- 2026-05-23: `arango_mcp` is retired; `mcp.mcp` takes its place with `list`/`search`/`describe` over the live tool catalog (targets: `tools`, `categories`, `surfaces`, or specific tool name); data source is the live `toolList` snapshot via closure.
- 2026-05-24: `mcp.tool.atlas` activates read-only `atlas.xxx` profiles over notes/edges; graph and view optimizations are reported as readiness hints, not mutated by atlas.
- 2026-05-24: `mcp.arango` primary flow is `search` then `exec`; `call` remains as a compatibility alias because hundreds of OpenAPI operations should not become hundreds of MCP tools.
