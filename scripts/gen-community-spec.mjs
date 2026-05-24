#!/usr/bin/env node
// scripts/gen-community-spec.mjs
// Generate the active community Arango OpenAPI schema from the full legacy spec.
// Strips operations that were enterprise-only before ArangoDB 3.12.5.
// See docs/arangodb-editions.md for the full feature list.
//
// Usage: node scripts/gen-community-spec.mjs [--dry-run]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const configDir = join(__dirname, '..', 'config')
const referenceDir = join(__dirname, '..', 'reference', 'arango')
const activeDir = join(__dirname, '..', 'arango', 'schema')

// Tags whose ALL operations are removed (formerly enterprise-only)
const ENTERPRISE_TAGS = new Set(['Hot Backups'])

// Individual operationIds removed even if their tag is kept
const ENTERPRISE_OPS = new Set(['rotateEncryptionAtRestKey'])

const dryRun = process.argv.includes('--dry-run')

const spec = JSON.parse(readFileSync(join(configDir, 'arango-openapi.json'), 'utf8'))

const filtered = { ...spec, paths: {}, tags: [] }
const removedOps = []
const keptOps = []

// Filter paths
for (const [pathTemplate, methods] of Object.entries(spec.paths)) {
  const filteredMethods = {}

  for (const [verb, op] of Object.entries(methods)) {
    if (!op || typeof op !== 'object') {
      filteredMethods[verb] = op
      continue
    }

    const hasEnterpriseTag = op.tags?.some(t => ENTERPRISE_TAGS.has(t))
    const isEnterpriseOp = ENTERPRISE_OPS.has(op.operationId)

    if (hasEnterpriseTag || isEnterpriseOp) {
      removedOps.push({ verb: verb.toUpperCase(), path: pathTemplate, operationId: op.operationId, reason: hasEnterpriseTag ? `tag:${op.tags.find(t => ENTERPRISE_TAGS.has(t))}` : `op:${op.operationId}` })
    } else {
      filteredMethods[verb] = op
      if (op.operationId) keptOps.push(op.operationId)
    }
  }

  if (Object.keys(filteredMethods).length > 0) {
    filtered.paths[pathTemplate] = filteredMethods
  }
}

// Filter top-level tags list
filtered.tags = (spec.tags || []).filter(t => !ENTERPRISE_TAGS.has(t.name))

// Add generated-file marker to info
filtered.info = {
  ...spec.info,
  'x-generated-from': 'config/arango-openapi.json',
  'x-generation-note': 'Community edition spec — enterprise-only operations removed. See docs/arangodb-editions.md.',
}

// Report
console.log(`Source: config/arango-openapi.json (${spec.info?.version})`)
console.log(`Removed: ${removedOps.length} operations`)
for (const r of removedOps) {
  console.log(`  - ${r.verb} ${r.path} (${r.operationId}) [${r.reason}]`)
}
console.log(`Kept: ${keptOps.length} operations`)

if (dryRun) {
  console.log('\n--dry-run: no file written')
  process.exit(0)
}

mkdirSync(referenceDir, { recursive: true })
mkdirSync(activeDir, { recursive: true })

const referencePath = join(referenceDir, 'community.openapi.json')
const activePath = join(activeDir, 'arango.openapi.schema.json')
writeFileSync(referencePath, JSON.stringify(filtered, null, 2) + '\n')
writeFileSync(activePath, JSON.stringify(filtered, null, 2) + '\n')
console.log(`\nWritten: ${referencePath}`)
console.log(`Written: ${activePath}`)
