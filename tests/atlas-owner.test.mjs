import { describe, it, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAtlasOwnerHandlers } from '../src/atlas-owner.mjs'

function fakeArangoApi() {
  const calls = []
  return {
    calls,
    callOperation: async (name, args) => {
      calls.push({ name, args })
      return { result: [{ ok: true }], hasMore: false }
    }
  }
}

let api
let handlers

beforeEach(() => {
  api = fakeArangoApi()
  handlers = createAtlasOwnerHandlers(api)
})

describe('atlas owner handlers', () => {
  it('lists atlas.xxx profiles', () => {
    const result = handlers['atlasOwner.list']({})
    const ids = result.profiles.map(profile => profile.id)
    assert.deepEqual(ids, ['atlas.index', 'atlas.focus', 'atlas.facets', 'atlas.types', 'atlas.viewpoints', 'atlas.audit'])
    assert.equal(result.total, 6)
  })

  it('searches profiles by keyword', () => {
    const result = handlers['atlasOwner.search']({ keywords: ['coverage'] })
    assert.equal(result.total, 1)
    assert.equal(result.profiles[0].id, 'atlas.viewpoints')
  })

  it('describes a profile contract', () => {
    const result = handlers['atlasOwner.describe']({ target: 'atlas.index' })
    assert.equal(result.id, 'atlas.index')
    assert.equal(result.params.root, 'required')
  })

  it('rejects unknown profile targets', async () => {
    assert.throws(
      () => handlers['atlasOwner.describe']({ target: 'atlas.nope' }),
      /unknown atlas profile/
    )
    await assert.rejects(
      () => handlers['atlasOwner.call']({ target: 'atlas.nope' }),
      /unknown atlas profile/
    )
  })

  it('atlas.index executes a read-only AQL cursor with root and edge collection bind vars', async () => {
    const result = await handlers['atlasOwner.call']({
      target: 'atlas.index',
      params: { root: 'notes/59537594', depth: 2 }
    })
    assert.equal(result.profile, 'atlas.index')
    assert.equal(result.count, 1)
    assert.equal(api.calls.length, 1)
    assert.equal(api.calls[0].name, 'createAqlQueryCursor')
    assert.equal(api.calls[0].args.bindVars.root, 'notes/59537594')
    assert.equal(api.calls[0].args.bindVars['@edgeCollection'], 'edges')
    assert.match(api.calls[0].args.query, /OUTBOUND @root @@edgeCollection/)
  })

  it('rejects collection override params before AQL dispatch', async () => {
    await assert.rejects(
      () => handlers['atlasOwner.call']({
        target: 'atlas.facets',
        params: { nodeCollection: '_users' }
      }),
      /atlas collection override is not allowed/
    )
    assert.equal(api.calls.length, 0)
  })

  it('atlas.facets unwraps type coordinates before returning navigation facets', async () => {
    await handlers['atlasOwner.call']({
      target: 'atlas.facets',
      params: { limit: 20 }
    })
    const { query, bindVars } = api.calls[0].args
    assert.equal(bindVars['@nodeCollection'], 'notes')
    assert.match(query, /FILTER IS_ARRAY\(n\.type\) AND LENGTH\(n\.type\) > 0/)
    assert.match(query, /FILTER LENGTH\(n\.type\) == LENGTH\(validTypeSegments\)/)
    assert.match(query, /LET typePathValue = CONCAT_SEPARATOR\("\/", validTypeSegments\)/)
    assert.match(query, /COLLECT root = rootValue, object = objectValue, aspect = aspectValue, subaspect = subaspectValue, typePath = typePathValue/)
    assert.match(query, /RETURN { root, object, aspect, subaspect, type_path: typePath, count }/)
    assert.match(query, /FILTER IS_STRING\(tag\)/)
    assert.match(query, /FILTER e\.rel == null OR IS_STRING\(e\.rel\)/)
  })

  it('atlas.types table reads the runtime type rule and observed type coordinates', async () => {
    api.callOperation = async (name, args) => {
      api.calls.push({ name, args })
      return {
        result: [
          { root: 'knowledge', object: 'runtime-schema', aspect: 'rule', subaspect: '-', count: 3, examples: ['Runtime schema note'] }
        ]
      }
    }
    const result = await handlers['atlasOwner.call']({
      target: 'atlas.types',
      params: { mode: 'table', root: ['knowledge'], examples: 1, limit: 10 }
    })
    assert.equal(result.profile, 'atlas.types')
    assert.equal(result.mode, 'table')
    assert.deepEqual(result.runtimeRule.firstLevel, ['todo', 'ongoing', 'archived', 'knowledge'])
    assert.deepEqual(result.results[0].root, 'knowledge')
    assert.equal(api.calls[0].name, 'createAqlQueryCursor')
    assert.deepEqual(api.calls[0].args.bindVars.root, ['knowledge'])
    assert.deepEqual(api.calls[0].args.bindVars.firstLevel, ['todo', 'ongoing', 'archived', 'knowledge'])
    assert.equal(api.calls[0].args.bindVars['@nodeCollection'], 'notes')
    assert.equal(api.calls[0].args.bindVars.depth, undefined)
    assert.equal(api.calls[0].args.bindVars.query, undefined)
    assert.equal(api.calls[0].args.bindVars.tags, undefined)
    assert.match(api.calls[0].args.query, /SLICE\(n\.type, 0, LENGTH\(rootPrefix\)\)/)
  })

  it('atlas.types suggest keeps scoring deterministic and bounded', async () => {
    api.callOperation = async (name, args) => {
      api.calls.push({ name, args })
      return {
        result: [
          { type: ['knowledge', 'runtime-schema', 'rule'], type_path: 'knowledge/runtime-schema/rule', score: 8, count: 2, examples: ['Runtime schema note'] }
        ]
      }
    }
    const result = await handlers['atlasOwner.call']({
      target: 'atlas.types',
      params: { mode: 'suggest', query: 'schema', tags: ['runtime'], examples: 2, limit: 5 }
    })
    assert.equal(result.mode, 'suggest')
    assert.equal(api.calls[0].args.bindVars.query, 'schema')
    assert.deepEqual(api.calls[0].args.bindVars.tags, ['runtime'])
    assert.equal(api.calls[0].args.bindVars.root, undefined)
    assert.equal(api.calls[0].args.bindVars.depth, undefined)
    assert.match(api.calls[0].args.query, /LET score = queryHit/)
  })

  it('atlas.types rejects collection overrides before AQL dispatch', async () => {
    await assert.rejects(
      () => handlers['atlasOwner.call']({
        target: 'atlas.types',
        params: { collection: '_users' }
      }),
      /atlas collection override is not allowed/
    )
    assert.equal(api.calls.length, 0)
  })

  it('rejects roots outside the notes collection before AQL dispatch', async () => {
    await assert.rejects(
      () => handlers['atlasOwner.call']({
        target: 'atlas.index',
        params: { root: '_users/root' }
      }),
      /atlas.index root must be in notes/
    )
    assert.equal(api.calls.length, 0)
  })

  it('atlas.focus requires params.root', async () => {
    await assert.rejects(
      () => handlers['atlasOwner.call']({ target: 'atlas.focus', params: {} }),
      /atlas.focus requires params.root/
    )
  })

  it('atlas.audit reports graph and view readiness through AQL', async () => {
    await handlers['atlasOwner.call']({ target: 'atlas.audit', params: { limit: 20 } })
    assert.equal(api.calls[0].name, 'createAqlQueryCursor')
    assert.equal(api.calls[0].args.bindVars.limit, 20)
    assert.equal(api.calls[0].args.bindVars['@nodeCollection'], undefined)
    assert.equal(api.calls[0].args.bindVars['@edgeCollection'], 'edges')
    assert.match(api.calls[0].args.query, /recommendedEdgeIndexes/)
    assert.match(api.calls[0].args.query, /notes_atlas_view/)
  })

  it('rejects ArangoDB AQL error envelopes', async () => {
    api.callOperation = async () => ({ error: true, errorNum: 11, errorMessage: 'not authorized to execute this request' })
    await assert.rejects(
      () => handlers['atlasOwner.call']({ target: 'atlas.audit', params: {} }),
      /atlas AQL failed \(11\): not authorized/
    )
  })
})
