export function createMcpHelpHandlers(getTools) {
  function list(payload) {
    const tools = getTools()
    if (!tools?.toolList) throw new Error('mcp.help unavailable before tools registry is ready')
    if (payload.target) return tools.helpFor(payload.target)
    return {
      targets: tools.toolList.map(tool => ({
        target: tool.name,
        title: tool.title,
        actions: tool.inputSchema.properties.action.enum
      }))
    }
  }

  function get(payload) {
    const tools = getTools()
    if (!tools?.helpFor) throw new Error('mcp.help unavailable before tools registry is ready')
    if (!payload.target || !payload.action) {
      throw new Error('mcp.help get requires payload.target and payload.action')
    }
    return tools.helpFor(payload.target, payload.action)
  }

  function dispatch(payload, action) {
    if (action === 'list') return list(payload)
    if (action === 'get') return get(payload)
    throw new Error(`unknown mcp.help action: ${action}`)
  }

  return {
    'mcpHelp.dispatch': dispatch
  }
}
