import { describe, it, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTemplateOwnerHandlers } from '../src/template-owner.mjs'
import { loadCatalog } from '../src/template-catalog.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

function seedCrud(templatesDir) {
  writeFileSync(join(templatesDir, 'crud.json'), JSON.stringify({
    category: 'crud',
    description: 'crud',
    templates: {
      find_by_key: {
        query: 'FOR d IN @@collection FILTER d._key == @key RETURN d',
        description: 'Find by key',
        params: {
          collection: { type: 'string', default: 'notes' },
          key: { type: 'string', required: true }
        }
      }
    }
  }, null, 2))
}

function fakeArangoApi() {
  const calls = []
  return {
    calls,
    callOperation: async (name, args) => {
      calls.push({ name, args })
      return { result: [{ _key: 'k1', value: 1 }], hasMore: false }
    }
  }
}

let templatesDir
let api
let handlers

beforeEach(() => {
  templatesDir = mkdtempSync(join(tmpdir(), 'tpl-'))
  seedCrud(templatesDir)
  api = fakeArangoApi()
  handlers = createTemplateOwnerHandlers(api, { templatesDir })
})

afterEach(() => {
  rmSync(templatesDir, { recursive: true, force: true })
})

describe('template owner handlers', () => {
  it('lists seeded templates and filters by category', () => {
    const result = handlers['templateOwner.list']({})
    assert.equal(result.total, 1)
    assert.equal(result.templates[0].id, 'crud.find_by_key')

    const matched = handlers['templateOwner.list']({ category: 'crud' })
    assert.equal(matched.total, 1)

    const missed = handlers['templateOwner.list']({ category: 'absent' })
    assert.equal(missed.total, 0)
  })

  it('searches by keyword', () => {
    const result = handlers['templateOwner.search']({ keywords: ['key'] })
    assert.equal(result.total, 1)
    assert.equal(result.templates[0].id, 'crud.find_by_key')

    const miss = handlers['templateOwner.search']({ keywords: ['nope'] })
    assert.equal(miss.total, 0)
  })

  it('describes a known template', () => {
    const result = handlers['templateOwner.describe']({ target: 'crud.find_by_key' })
    assert.equal(result.id, 'crud.find_by_key')
    assert.equal(result.category, 'crud')
    assert.ok(result.query.includes('@@collection'))
  })

  it('rejects describe for unknown template', () => {
    assert.throws(
      () => handlers['templateOwner.describe']({ target: 'no.such' }),
      /unknown template/
    )
  })

  it('call executes via createAqlQueryCursor with rewritten bindVars', async () => {
    const result = await handlers['templateOwner.call']({
      target: 'crud.find_by_key',
      params: { key: 'k1' }
    })
    assert.equal(api.calls.length, 1)
    assert.equal(api.calls[0].name, 'createAqlQueryCursor')
    assert.equal(api.calls[0].args.bindVars.key, 'k1')
    assert.equal(api.calls[0].args.bindVars['@collection'], 'notes')
    assert.equal('collection' in api.calls[0].args.bindVars, false)
    assert.deepEqual(result, {
      template: 'crud.find_by_key',
      count: 1,
      results: [{ _key: 'k1', value: 1 }]
    })
  })

  it('call rejects missing required parameter', async () => {
    await assert.rejects(
      () => handlers['templateOwner.call']({ target: 'crud.find_by_key', params: {} }),
      /missing required parameter: key/
    )
  })

  it('meta.create writes a new template and surfaces in list', async () => {
    const result = await handlers['templateOwner.call']({
      target: 'meta.create',
      params: {
        category: 'crud',
        name: 'count_all',
        query: 'RETURN LENGTH(@@collection)',
        paramsSchema: { collection: { type: 'string', default: 'notes' } }
      }
    })
    assert.deepEqual(result, { ok: true, id: 'crud.count_all' })

    const listed = handlers['templateOwner.list']({})
    const ids = listed.templates.map(t => t.id).sort()
    assert.deepEqual(ids, ['crud.count_all', 'crud.find_by_key'])
  })

  it('meta.create rejects duplicate template id', async () => {
    await assert.rejects(
      () => handlers['templateOwner.call']({
        target: 'meta.create',
        params: {
          category: 'crud',
          name: 'find_by_key',
          query: 'RETURN 1'
        }
      }),
      /already exists/
    )
  })

  it('meta.update patches an existing template', async () => {
    await handlers['templateOwner.call']({
      target: 'meta.update',
      params: {
        category: 'crud',
        name: 'find_by_key',
        description: 'patched desc'
      }
    })
    const described = handlers['templateOwner.describe']({ target: 'crud.find_by_key' })
    assert.equal(described.description, 'patched desc')
    assert.ok(described.query.includes('@@collection'))
  })

  it('meta.update rejects missing template', async () => {
    await assert.rejects(
      () => handlers['templateOwner.call']({
        target: 'meta.update',
        params: { category: 'crud', name: 'absent', description: 'x' }
      }),
      /template not found/
    )
  })

  it('meta.remove deletes a template and removes empty category file', async () => {
    const result = await handlers['templateOwner.call']({
      target: 'meta.remove',
      params: { category: 'crud', name: 'find_by_key' }
    })
    assert.equal(result.ok, true)
    assert.equal(result.removedCategory, true)
    assert.equal(existsSync(join(templatesDir, 'crud.json')), false)
    assert.throws(
      () => handlers['templateOwner.describe']({ target: 'crud.find_by_key' }),
      /unknown template/
    )
  })

  it('meta.validate reports ok and the resolved bindVars', async () => {
    const result = await handlers['templateOwner.call']({
      target: 'meta.validate',
      params: { id: 'crud.find_by_key', args: { key: 'abc' } }
    })
    assert.equal(result.ok, true)
    assert.equal(result.id, 'crud.find_by_key')
    assert.equal(result.bindVars.key, 'abc')
    assert.equal(result.bindVars['@collection'], 'notes')
  })

  it('meta.validate reports error for missing required arg', async () => {
    const result = await handlers['templateOwner.call']({
      target: 'meta.validate',
      params: { id: 'crud.find_by_key', args: {} }
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /missing required parameter: key/)
  })

  it('meta.remove keeps category file when other templates remain', async () => {
    await handlers['templateOwner.call']({
      target: 'meta.create',
      params: { category: 'crud', name: 'second', query: 'RETURN 1' }
    })
    const result = await handlers['templateOwner.call']({
      target: 'meta.remove',
      params: { category: 'crud', name: 'second' }
    })
    assert.equal(result.removedCategory, false)
    const file = JSON.parse(readFileSync(join(templatesDir, 'crud.json'), 'utf8'))
    assert.deepEqual(Object.keys(file.templates), ['find_by_key'])
  })

  it('production catalog exposes the curated memory.view template', () => {
    const catalog = loadCatalog(join(rootDir, 'config/templates'))
    const template = catalog.get('memory.view')
    assert.ok(template)
    assert.equal(template.description, 'Time-ordered notes view with optional query, tags, type, root/depth neighborhood, and sort mode.')
    assert.deepEqual(Object.keys(template.params), ['query', 'tags', 'type', 'root', 'depth', 'limit', 'sort'])
  })

  it('production catalog exposes curated topology, insert, and atlas templates', () => {
    const catalog = loadCatalog(join(rootDir, 'config/templates'))
    const expected = {
      'topology.neighborhood': ['root', 'depth', 'relation', 'limit'],
      'topology.path': ['from', 'to'],
      'insert.candidates': ['query', 'tags', 'type', 'limit'],
      'atlas.metrics': ['limit']
    }
    for (const [id, params] of Object.entries(expected)) {
      const template = catalog.get(id)
      assert.ok(template, `missing ${id}`)
      assert.deepEqual(Object.keys(template.params), params)
    }
  })

  it('memory.view executes through template owner with stable bind vars', async () => {
    const productionHandlers = createTemplateOwnerHandlers(api, { templatesDir: join(rootDir, 'config/templates') })
    const result = await productionHandlers['templateOwner.call']({
      target: 'memory.view',
      params: {
        query: 'handbook',
        tags: ['knowledge-organization'],
        type: ['knowledge'],
        root: 'notes/59537594',
        depth: 2,
        limit: 5,
        sort: 'relevance'
      }
    })
    assert.equal(api.calls.length, 1)
    assert.equal(api.calls[0].name, 'createAqlQueryCursor')
    assert.equal(api.calls[0].args.bindVars.query, 'handbook')
    assert.deepEqual(api.calls[0].args.bindVars.tags, ['knowledge-organization'])
    assert.deepEqual(api.calls[0].args.bindVars.type, ['knowledge'])
    assert.equal(api.calls[0].args.bindVars.root, 'notes/59537594')
    assert.equal(api.calls[0].args.bindVars.depth, 2)
    assert.equal(api.calls[0].args.bindVars.limit, 5)
    assert.equal(api.calls[0].args.bindVars.sort, 'relevance')
    assert.equal(result.template, 'memory.view')
  })

  it('topology.neighborhood executes through template owner with stable bind vars', async () => {
    const productionHandlers = createTemplateOwnerHandlers(api, { templatesDir: join(rootDir, 'config/templates') })
    const result = await productionHandlers['templateOwner.call']({
      target: 'topology.neighborhood',
      params: {
        root: 'notes/59537594',
        depth: 2,
        relation: ['supports', 'references'],
        limit: 7
      }
    })
    assert.equal(api.calls[0].name, 'createAqlQueryCursor')
    assert.equal(api.calls[0].args.bindVars.root, 'notes/59537594')
    assert.equal(api.calls[0].args.bindVars.depth, 2)
    assert.deepEqual(api.calls[0].args.bindVars.relation, ['supports', 'references'])
    assert.equal(api.calls[0].args.bindVars.limit, 7)
    assert.equal(result.template, 'topology.neighborhood')
  })

  it('topology.path executes through template owner with stable bind vars', async () => {
    const productionHandlers = createTemplateOwnerHandlers(api, { templatesDir: join(rootDir, 'config/templates') })
    const result = await productionHandlers['templateOwner.call']({
      target: 'topology.path',
      params: {
        from: 'notes/59537594',
        to: 'notes/56578218'
      }
    })
    assert.equal(api.calls[0].name, 'createAqlQueryCursor')
    assert.equal(api.calls[0].args.bindVars.from, 'notes/59537594')
    assert.equal(api.calls[0].args.bindVars.to, 'notes/56578218')
    assert.equal(result.template, 'topology.path')
  })

  it('insert.candidates executes through template owner with stable bind vars', async () => {
    const productionHandlers = createTemplateOwnerHandlers(api, { templatesDir: join(rootDir, 'config/templates') })
    const result = await productionHandlers['templateOwner.call']({
      target: 'insert.candidates',
      params: {
        query: 'atlas template',
        tags: ['handbook', 'topology'],
        type: ['knowledge'],
        limit: 9
      }
    })
    assert.equal(api.calls[0].name, 'createAqlQueryCursor')
    assert.equal(api.calls[0].args.bindVars.query, 'atlas template')
    assert.deepEqual(api.calls[0].args.bindVars.tags, ['handbook', 'topology'])
    assert.deepEqual(api.calls[0].args.bindVars.type, ['knowledge'])
    assert.equal(api.calls[0].args.bindVars.limit, 9)
    assert.equal(result.template, 'insert.candidates')
  })

  it('atlas.metrics executes through template owner with stable bind vars', async () => {
    const productionHandlers = createTemplateOwnerHandlers(api, { templatesDir: join(rootDir, 'config/templates') })
    const result = await productionHandlers['templateOwner.call']({
      target: 'atlas.metrics',
      params: { limit: 6 }
    })
    assert.equal(api.calls[0].name, 'createAqlQueryCursor')
    assert.equal(api.calls[0].args.bindVars.limit, 6)
    assert.equal(result.template, 'atlas.metrics')
  })
})
