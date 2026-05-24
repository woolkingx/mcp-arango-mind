#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: handbook-link-check.mjs <handbook-dir>')
  process.exit(2)
}

const htmls = readdirSync(dir).filter(f => f.endsWith('.html'))
let broken = 0
for (const f of htmls) {
  const file = join(dir, f)
  const html = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  for (const m of html.matchAll(/href="([^"#][^"]*)"/g)) {
    const href = m[1]
    if (/^[a-z]+:\/\//i.test(href) || href.startsWith('mailto:')) continue
    const target = resolve(dirname(file), href.split('#')[0])
    if (!existsSync(target)) {
      console.log(`DANGLING ${f} -> ${href}`)
      broken++
    }
  }
}

console.log(broken ? `FAIL ${broken} dangling` : 'OK all links resolve')
process.exit(broken ? 1 : 0)
