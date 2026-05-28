import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { json2md } from '../src/lib/json2md.mjs'

describe('json2md', () => {
  it('renders nested arrays of objects without object stringification leaks', () => {
    const md = json2md({
      profile: 'atlas.facets',
      count: 1,
      results: [
        {
          types: [
            { root: 'knowledge', object: 'architecture', aspect: 'insight', count: 22 }
          ],
          tags: [
            { value: 'architecture', count: 125 }
          ],
          relations: [
            { value: 'leads', count: 266 }
          ],
          relationClasses: {
            structural: ['has', 'is'],
            history: ['from', 'leads']
          }
        }
      ]
    })

    assert.doesNotMatch(md, /\[object Object\]/)
    assert.match(md, /## results/)
    assert.match(md, /\*\*types\*\*/)
    assert.match(md, /\| root \| object \| aspect \| count \|/)
    assert.match(md, /\*\*relationClasses\*\*:/)
  })
})
