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
    assert.deepEqual(ids, ['atlas.index', 'atlas.focus', 'atlas.facets', 'atlas.viewpoints', 'atlas.audit'])
    assert.equal(result.total, 5)
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
