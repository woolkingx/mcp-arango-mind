const SURFACES = [
  { name: 'mcp.mcp', root: 'mcp/', purpose: 'Expose MCP reference metadata and small MCP-facing helpers.' },
  { name: 'mcp.arango', root: 'arango/', purpose: 'Raw ArangoDB OpenAPI discovery and generic operation dispatch.' },
  { name: 'mcp.tool.*', root: 'tools/', purpose: 'Local/custom tool owners split by category.' }
]

const META_TARGETS = new Set(['tools', 'categories', 'surfaces'])

function categoryOf(toolName) {
  if (toolName.startsWith('mcp.tool.')) return toolName.slice('mcp.tool.'.length)
  if (toolName.startsWith('mcp.')) return 'mcp'
  return 'other'
}

function projectTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    actions: tool.actions
  }
}

function actionsOf(tool) {
  return tool?.inputSchema?.properties?.action?.enum || []
}

function buildSnapshot(getTools) {
  const snapshot = getTools()
  const tools = (snapshot?.toolList || []).map(tool => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    category: categoryOf(tool.name),
    actions: actionsOf(tool)
  }))
  const categories = {}
  for (const tool of tools) {
    (categories[tool.category] ||= []).push(tool.name)
  }
  return { tools, categories }
}

export function createMcpMetaHandlers(getTools) {
  function list(payload) {
    const target = payload.target || 'tools'
    const limit = payload.limit ?? 100
    if (!META_TARGETS.has(target)) {
      throw new Error(`unknown target for mcp.mcp.list: ${target}`)
    }
    const { tools, categories } = buildSnapshot(getTools)
    if (target === 'tools') {
      const slice = tools.slice(0, limit).map(projectTool)
      return { target: 'tools', items: slice, total: slice.length, limit }
    }
    if (target === 'categories') {
      const items = Object.entries(categories).sort().map(([name, list]) => ({ name, tools: list, count: list.length }))
      return { target: 'categories', items, total: items.length }
    }
    return { target: 'surfaces', items: SURFACES, total: SURFACES.length }
  }

  function search(payload) {
    const keywords = payload.keywords.map(keyword => keyword.toLowerCase())
    const scope = payload.scope || 'tools'
    const limit = payload.limit ?? 100
    const { tools } = buildSnapshot(getTools)
    if (scope === 'tools') {
      const matches = []
      for (const tool of tools) {
        const text = `${tool.name} ${tool.title} ${tool.description} ${tool.category}`.toLowerCase()
        if (keywords.every(keyword => text.includes(keyword))) matches.push(projectTool(tool))
        if (matches.length >= limit) break
      }
      return { scope, items: matches, total: matches.length, limit, keywords: payload.keywords }
    }
    throw new Error(`unknown scope for mcp.mcp.search: ${scope}`)
  }

  function describe(payload) {
    const target = payload.target
    if (target === 'tools' || target === 'categories' || target === 'surfaces') {
      return list({ target })
    }
    const { tools, categories } = buildSnapshot(getTools)
    const tool = tools.find(t => t.name === target)
    if (tool) return { kind: 'tool', ...projectTool(tool), category: tool.category }
    if (categories[target]) return { kind: 'category', name: target, tools: categories[target], count: categories[target].length }
    const surface = SURFACES.find(s => s.name === target)
    if (surface) return { kind: 'surface', ...surface }
    throw new Error(`unknown target for mcp.mcp.describe: ${target}`)
  }

  return {
    'mcpMeta.list': list,
    'mcpMeta.search': search,
    'mcpMeta.describe': describe
  }
}
