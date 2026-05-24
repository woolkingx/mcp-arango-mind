#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: handbook-parse.mjs <index.html>')
  process.exit(2)
}

const html = readFileSync(file, 'utf8')
const sections = []
for (const m of html.matchAll(/<section[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)) {
  const id = m[1]
  const body = m[2]
  const title = (body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [, id])[1].replace(/<[^>]+>/g, '').trim()
  const links = [...body.matchAll(/href="([^"]+)"/g)].map(x => x[1])
  sections.push({ id, title, links })
}
const gates = [...new Set([...html.matchAll(/GATE-[A-Z0-9]+-\d+/g)].map(x => x[0]))]
process.stdout.write(JSON.stringify({ sections, gates }, null, 2) + '\n')
