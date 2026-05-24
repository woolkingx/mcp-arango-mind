const DEFAULT_NODE_COLLECTION = 'notes'
const DEFAULT_EDGE_COLLECTION = 'edges'
const DEFAULT_DEPTH = 2
const DEFAULT_LIMIT = 100

const RELATION_CLASSES = {
  structural: ['has', 'is'],
  history: ['from', 'leads', 'produces', 'replaces'],
  topology: ['needs', 'enables', 'blocks', 'related', 'excludes', 'not'],
  legacy: ['', null]
}

const VIEWPOINTS = [
  'data',
  'ontology',
  'schema',
  'boundary',
  'topology',
  'layer',
  'osi',
  'logic',
  'transition',
  'evidence',
  'proof'
]

function clamp(value, fallback, max = 500) {
  const n = Number.isInteger(value) ? value : fallback
  return Math.max(1, Math.min(max, n))
}

function profileRecord(profile) {
  return {
    id: profile.id,
    title: profile.title,
    description: profile.description,
    params: profile.params
  }
}

function matchesKeywords(profile, keywords) {
  const haystack = `${profile.id} ${profile.title} ${profile.description}`.toLowerCase()
  return keywords.every(keyword => haystack.includes(keyword.toLowerCase()))
}

function requireRoot(params, profile) {
  if (!params.root) throw new Error(`${profile} requires params.root`)
  if (typeof params.root !== 'string' || !new RegExp(`^${DEFAULT_NODE_COLLECTION}/[^/]+$`).test(params.root)) {
    throw new Error(`${profile} root must be in ${DEFAULT_NODE_COLLECTION}`)
  }
  return params.root
}

function baseBindVars(params, payload) {
  return {
    limit: clamp(params.limit ?? payload.limit, DEFAULT_LIMIT)
  }
}

function nodeFieldsBindVar() {
  return ['_id', '_key', 'title', 'type', 'tags', 'weight', 'created_at']
}

function collectionNames(params) {
  if (params.nodeCollection !== undefined || params.edgeCollection !== undefined) {
    throw new Error('atlas collection override is not allowed')
  }
  return {
    nodeCollection: DEFAULT_NODE_COLLECTION,
    edgeCollection: DEFAULT_EDGE_COLLECTION
  }
}

function indexQuery(params, payload) {
  const root = requireRoot(params, 'atlas.index')
  const { edgeCollection } = collectionNames(params)
  return {
    query: `
LET root = DOCUMENT(@root)
LET tree = (
  FOR v,e,p IN 1..@depth OUTBOUND @root @@edgeCollection OPTIONS { uniqueVertices: "path" }
    FILTER e.rel IN @structuralRels
    SORT LENGTH(p.edges), v.weight DESC, v.title
    LIMIT @limit
    RETURN { depth: LENGTH(p.edges), rel: e.rel, node: KEEP(v, @nodeFields), edge: KEEP(e, ["_id", "_key", "rel", "weight", "tags"]) }
)
LET sources = (
  FOR e IN @@edgeCollection
    FILTER e._from == @root AND e.rel IN @sourceRels
    LET v = DOCUMENT(e._to)
    SORT e.weight DESC, v.weight DESC, v.title
    LIMIT @limit
    RETURN { rel: e.rel, node: KEEP(v, @nodeFields), edge: KEEP(e, ["_id", "_key", "rel", "weight", "tags"]) }
)
RETURN { root: KEEP(root, @nodeFields), tree, sources }`,
    bindVars: {
      ...baseBindVars(params, payload),
      '@edgeCollection': edgeCollection,
      nodeFields: nodeFieldsBindVar(),
      root,
      depth: clamp(params.depth, DEFAULT_DEPTH, 4),
      structuralRels: RELATION_CLASSES.structural,
      sourceRels: RELATION_CLASSES.history
    }
  }
}

function focusQuery(params, payload) {
  const root = requireRoot(params, 'atlas.focus')
  const { edgeCollection } = collectionNames(params)
  return {
    query: `
LET root = DOCUMENT(@root)
LET outgoing = (
  FOR e IN @@edgeCollection
    FILTER e._from == @root
    COLLECT rel = e.rel WITH COUNT INTO count
    SORT count DESC, rel
    RETURN { rel, count }
)
LET incoming = (
  FOR e IN @@edgeCollection
    FILTER e._to == @root
    COLLECT rel = e.rel WITH COUNT INTO count
    SORT count DESC, rel
    RETURN { rel, count }
)
RETURN { root: KEEP(root, @nodeFields), outgoing, incoming, relationClasses: @relationClasses }`,
    bindVars: { ...baseBindVars(params, payload), '@edgeCollection': edgeCollection, nodeFields: nodeFieldsBindVar(), root, relationClasses: RELATION_CLASSES }
  }
}

function facetsQuery(params, payload) {
  const { nodeCollection, edgeCollection } = collectionNames(params)
  return {
    query: `
LET types = (
  FOR n IN @@nodeCollection
    COLLECT value = n.type WITH COUNT INTO count
    SORT count DESC, value
    LIMIT @limit
    RETURN { value, count }
)
LET tags = (
  FOR n IN @@nodeCollection
    FOR tag IN (IS_ARRAY(n.tags) ? n.tags : [])
      COLLECT value = tag WITH COUNT INTO count
      SORT count DESC, value
      LIMIT @limit
      RETURN { value, count }
)
LET relations = (
  FOR e IN @@edgeCollection
    COLLECT value = e.rel WITH COUNT INTO count
    SORT count DESC, value
    LIMIT @limit
    RETURN { value, count }
)
RETURN { types, tags, relations, relationClasses: @relationClasses }`,
    bindVars: { ...baseBindVars(params, payload), '@nodeCollection': nodeCollection, '@edgeCollection': edgeCollection, relationClasses: RELATION_CLASSES }
  }
}

function viewpointsQuery(params, payload) {
  const { nodeCollection } = collectionNames(params)
  return {
    query: `
FOR viewpoint IN @viewpoints
  LET matches = (
    FOR n IN @@nodeCollection
      FILTER viewpoint IN (IS_ARRAY(n.tags) ? n.tags : []) OR CONTAINS(LOWER(n.title || ""), viewpoint)
      SORT n.weight DESC, n.title
      LIMIT @limit
      RETURN KEEP(n, @nodeFields)
  )
  LET count = LENGTH(matches)
  RETURN { viewpoint, count, status: count == 0 ? "missing" : (count < @weakBelow ? "weak" : "covered"), matches }`,
    bindVars: { ...baseBindVars(params, payload), '@nodeCollection': nodeCollection, nodeFields: nodeFieldsBindVar(), viewpoints: params.viewpoints || VIEWPOINTS, weakBelow: clamp(params.weakBelow, 3, 20) }
  }
}

function auditQuery(params, payload) {
  const { nodeCollection, edgeCollection } = collectionNames(params)
  return {
    query: `
LET relationCounts = (
  FOR e IN @@edgeCollection
    COLLECT rel = e.rel WITH COUNT INTO count
    SORT count DESC, rel
    LIMIT @limit
    RETURN { rel, count }
)
RETURN {
  relationCounts,
  recommendedGraph: { name: "notes_graph", edgeCollection: @edgeCollection, from: @nodeCollection, to: @nodeCollection },
  recommendedEdgeIndexes: [["rel"], ["_from", "rel"], ["_to", "rel"], ["tags[*]"]],
  recommendedView: { name: "notes_atlas_view", collection: @nodeCollection, fields: ["title", "content", "tags", "type", "status", "created_at", "weight"] }
}`,
    bindVars: { ...baseBindVars(params, payload), '@edgeCollection': edgeCollection, nodeCollection, edgeCollection }
  }
}

const PROFILES = new Map([
  ['atlas.index', { id: 'atlas.index', title: 'Atlas Index', description: 'Rooted structural tree plus source/history links.', params: { root: 'required', depth: '1..4', limit: '1..500' }, build: indexQuery }],
  ['atlas.focus', { id: 'atlas.focus', title: 'Atlas Focus', description: 'Incoming and outgoing relation distribution around one node.', params: { root: 'required' }, build: focusQuery }],
  ['atlas.facets', { id: 'atlas.facets', title: 'Atlas Facets', description: 'Type, tag, and relation distributions for navigation.', params: { limit: '1..500' }, build: facetsQuery }],
  ['atlas.viewpoints', { id: 'atlas.viewpoints', title: 'Atlas Viewpoints', description: 'Coverage report for system-thinking viewpoints.', params: { viewpoints: 'optional string array', limit: '1..500' }, build: viewpointsQuery }],
  ['atlas.audit', { id: 'atlas.audit', title: 'Atlas Audit', description: 'Graph/view/index readiness hints plus relation distribution.', params: { limit: '1..500' }, build: auditQuery }]
])

export function createAtlasOwnerHandlers(arangoApi) {
  function list(payload) {
    const limit = payload.limit ?? DEFAULT_LIMIT
    const profiles = [...PROFILES.values()].slice(0, limit).map(profileRecord)
    return { profiles, total: profiles.length, limit }
  }

  function search(payload) {
    const profiles = [...PROFILES.values()].filter(profile => matchesKeywords(profile, payload.keywords)).slice(0, payload.limit ?? DEFAULT_LIMIT).map(profileRecord)
    return { profiles, total: profiles.length, limit: payload.limit ?? DEFAULT_LIMIT, keywords: payload.keywords }
  }

  function describe(payload) {
    const profile = PROFILES.get(payload.target)
    if (!profile) throw new Error(`unknown atlas profile: ${payload.target}`)
    return profileRecord(profile)
  }

  async function call(payload) {
    const profile = PROFILES.get(payload.target)
    if (!profile) throw new Error(`unknown atlas profile: ${payload.target}`)
    const { query, bindVars } = profile.build(payload.params || {}, payload)
    const response = await arangoApi.callOperation('createAqlQueryCursor', { query, bindVars })
    if (response?.error) {
      const code = response.errorNum || response.code || 'unknown'
      const message = response.errorMessage || 'ArangoDB query failed'
      throw new Error(`atlas AQL failed (${code}): ${message}`)
    }
    const results = Array.isArray(response?.result) ? response.result : []
    return { profile: profile.id, count: results.length, results }
  }

  return {
    'atlasOwner.list': list,
    'atlasOwner.search': search,
    'atlasOwner.describe': describe,
    'atlasOwner.call': call
  }
}
