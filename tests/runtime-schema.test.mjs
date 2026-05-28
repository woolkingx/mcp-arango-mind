import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntimeSchemaRegistry, loadRuntimeSchemas } from '../src/runtime-schema.mjs'

describe('runtime collection schema registry', () => {
  it('loads every runtime collection schema by collection name', () => {
    const registry = createRuntimeSchemaRegistry()
    assert.deepEqual(registry.listCollections(), ['access_logs', 'edges', 'notes', 'tag_edges', 'tags', 'todos'])
  })

  it('rejects invalid runtime schema files through the schema2object gate', () => {
    const schemaDir = mkdtempSync(join(tmpdir(), 'runtime-schema-'))
    try {
      writeFileSync(join(schemaDir, 'bad.json'), JSON.stringify({
        name: 'bad',
        schema: { type: 'object' }
      }))
      assert.throws(
        () => loadRuntimeSchemas(schemaDir),
        /invalid runtime schema file bad\.json.*collection/
      )
    } finally {
      rmSync(schemaDir, { recursive: true, force: true })
    }
  })

  it('loads notes.type rule from the runtime collection schema', () => {
    const registry = createRuntimeSchemaRegistry()
    const rule = registry.getTypeRule('notes')
    assert.deepEqual(rule, {
      field: 'type',
      firstLevel: ['todo', 'ongoing', 'archived', 'knowledge'],
      segmentRoles: ['state', 'object', 'property', 'subcoordinate']
    })
  })

  it('validates documents through the runtime schema operator', () => {
    const registry = createRuntimeSchemaRegistry()
    const result = registry.validate('notes', {
      title: 'Runtime schema note',
      content: 'Schema is a project runtime contract.',
      tags: ['schema', 'runtime', 'notes'],
      type: ['knowledge', 'runtime-schema', 'rule'],
      weight: 70,
      created_at: '2026-05-24T00:00:00Z'
    })
    assert.equal(result.valid, true)
  })

  it('rejects notes.type roots outside x-first-level', () => {
    const registry = createRuntimeSchemaRegistry()
    const result = registry.validate('notes', {
      title: 'Bad type root',
      content: 'This document uses an illegal first-level root.',
      tags: ['schema', 'runtime', 'notes'],
      type: ['project', 'runtime-schema'],
      weight: 50,
      created_at: '2026-05-24T00:00:00Z'
    })
    assert.equal(result.valid, false)
    assert.match(result.errors.join('\n'), /notes\.type\[0\].*x-first-level/)
  })

  it('rejects invalid full documents for migrated collection schemas', () => {
    const registry = createRuntimeSchemaRegistry()
    const result = registry.validate('tags', { label: '' })
    assert.equal(result.valid, false)
  })

  it('validates only supplied fields in partial mode', () => {
    const registry = createRuntimeSchemaRegistry()
    assert.equal(registry.validate('notes', { weight: 10 }, { mode: 'partial' }).valid, true)
    assert.equal(registry.validate('notes', { weight: 'bad' }, { mode: 'partial' }).valid, false)
    assert.equal(registry.validate('notes', { type: ['project'] }, { mode: 'partial' }).valid, false)
  })
})
