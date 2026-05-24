# mcp-arango-mind

An ArangoDB MCP server for agents that need more than a database wrapper.

`mcp-arango-mind` turns ArangoDB into a schema-driven tool surface: discover the operation you need, inspect the contract, execute it with structured parameters, and keep higher-level knowledge workflows in templates and atlas projections instead of oversized tool lists.

The project is built for three jobs:

- use ArangoDB as a document, graph, and search substrate from MCP clients
- keep the MCP surface small with `search -> describe -> exec` instead of hundreds of exposed tools
- turn notes, edges, templates, views, and graph topology into handbook-style knowledge coordinates

It has zero npm dependencies and runs on Node.js built-ins.

## Why It Exists

Agent database tooling has two common failure modes: every database operation becomes a separate MCP tool, or the agent has to hand-write queries without enough local context. Both scale badly.

This server uses a layered surface:

```text
MCP client
  -> small MCP tool surface
  -> schema-owned tool owners
  -> ArangoDB OpenAPI operation catalog
  -> ArangoDB
```

Large catalogs stay searchable. Stable workflows become templates. Knowledge structure becomes atlas projections. The agent keeps a coordinate system instead of guessing through a giant action menu.

## Current Surface

| Tool | Use |
|---|---|
| `mcp.mcp` | Inspect the live MCP tool catalog, categories, and surface roots. |
| `mcp.arango` | Search, describe, and execute raw ArangoDB OpenAPI operations. |
| `mcp.tool.database` | Work with ArangoDB database lifecycle operations. |
| `mcp.tool.collection` | Work with collections, documents, indexes, and CRUD schema gates. |
| `mcp.tool.view` | Work with ArangoSearch views and analyzers. |
| `mcp.tool.graph` | Work with ArangoDB graph operations. |
| `mcp.tool.admin` | Work with administration, AQL, monitoring, and task operations. |
| `mcp.tool.template` | List, search, validate, manage, and execute curated AQL templates. |
| `mcp.tool.atlas` | Read handbook-style projections over notes, edges, topology, and readiness hints. |

The generic ArangoDB flow is:

```text
mcp.arango search -> mcp.arango describe -> mcp.arango exec
```

Category tools use the same small-action style:

```text
list | search | describe | call
```

The target operation, template, or atlas profile lives in `payload.target`.

## Quick Start

```bash
git clone https://github.com/woolkingx/mcp-arango-mind.git
cd mcp-arango-mind

cp .env.example .env
# Edit .env with your ArangoDB connection details.

node server.mjs
```

No `npm install` is required.

For HTTP transport:

```bash
node server.mjs --sse --port 8000
```

## Configuration

The connection cascade is:

```text
CLI flags
  -> environment variables
  -> .env
  -> config/profiles.json
  -> config/arango-connection.json schema defaults
```

Common environment variables:

| Variable | Default | Description |
|---|---|---|
| `ARANGO_URL` | `http://127.0.0.1:8529` | ArangoDB server URL. |
| `ARANGO_DB` | `_system` | Database name. |
| `ARANGO_USERNAME` | `root` | Basic auth username. |
| `ARANGO_PASSWORD` | empty | Basic auth password. |
| `ARANGO_TOKEN` | unset | Bearer token; overrides username and password. |
| `ARANGO_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, `debug`, or `trace`. |

Useful CLI flags:

```text
--profile <name>    Select profile from config/profiles.json
--debug             Force debug logging
--sse               Use HTTP JSON transport
--port <number>     HTTP port, default 8000
--host <address>    HTTP bind address, default 127.0.0.1
--audit <file>      Write structured JSON audit events
```

## Example Calls

Search the ArangoDB OpenAPI catalog:

```json
{
  "action": "search",
  "payload": {
    "query": "collection create"
  }
}
```

Execute a known operation:

```json
{
  "action": "exec",
  "payload": {
    "target": "createCollection",
    "params": {
      "name": "notes",
      "type": 2
    }
  }
}
```

Run a curated template:

```json
{
  "action": "call",
  "payload": {
    "target": "memory.view",
    "params": {
      "query": "handbook",
      "tags": ["knowledge-organization"],
      "limit": 10
    }
  }
}
```

Read an atlas projection:

```json
{
  "action": "call",
  "payload": {
    "target": "atlas.index",
    "params": {
      "root": "notes/root",
      "depth": 2
    }
  }
}
```

MCP clients send these payloads through `tools/call` with the corresponding tool name, such as `mcp.arango`, `mcp.tool.template`, or `mcp.tool.atlas`.

## Handbook

The public README is the quickstart and product entry. Architecture truth lives in the handbook:

- [Handbook index](docs/handbook/index.html)
- [Tool surfaces](docs/handbook/tool-surfaces.html)
- [Tool categories](docs/handbook/tool-categories.html)
- [Known risks](docs/handbook/known-risks.html)
- [Roadmap](docs/handbook/roadmap.html)
- [Changelog](CHANGELOG.md)

The handbook records owner boundaries, schema roots, topology, acceptance gates, migration rationale, and the atlas design.

## Verification

```bash
npm test
node scripts/handbook-link-check.mjs docs/handbook
node scripts/handbook-parse.mjs docs/handbook/index.html
```

Live ArangoDB checks use the connection from `.env` or environment variables. Tests that require ArangoDB skip when no live connection is configured.

## Project Status

Current release line: `0.2.0`.

Runtime boundary:

- Node.js 22+
- zero npm dependencies
- MCP stdio transport by default
- HTTP JSON transport via `--sse`
- ArangoDB operation contracts projected from `arango/schema/arango.openapi.schema.json`
- tool activation projected from `tools/schema/tools.schema.json`

File-size discipline:

- project-owned `.mjs` files stay under 500 lines
- 200 lines is the recommended split checkpoint
- vendored `src/lib/schema2object.mjs` follows its sync gate

## License

MIT
