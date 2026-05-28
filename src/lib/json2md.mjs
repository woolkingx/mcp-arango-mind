// json2md.mjs — JSON to Markdown converter for MCP tool output.
// Reduces token usage ~40% by eliminating JSON syntax overhead.
// Inspired by IonicaBizau/json2md converter pattern.

// Fields to omit from output (noise for LLM consumers)
const OMIT_KEYS = new Set(['guid', 'feed_url', 'fetched_at'])

// Fields that are URLs — render as markdown links when title is available
const URL_KEYS = new Set(['link', 'url', 'source'])

/**
 * Convert any JSON-serializable value to compact Markdown.
 * Handles: primitives, flat objects, arrays of objects (→ table or list), nested.
 */
export function json2md(data, depth = 0) {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data
  if (typeof data === 'number' || typeof data === 'boolean') return String(data)

  if (Array.isArray(data)) {
    if (data.length === 0) return '(empty)'
    if (typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0])) {
      return arrayToMd(data)
    }
    return data.map(item => `- ${json2md(item, depth + 1)}`).join('\n')
  }

  return objectToMd(data, depth)
}

// --- Object rendering ---

function objectToMd(obj, depth) {
  const entries = Object.entries(obj).filter(([k, v]) =>
    v !== null && v !== undefined && !OMIT_KEYS.has(k)
  )
  if (entries.length === 0) return '(empty)'

  const lines = []
  for (const [key, value] of entries) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      const hLevel = Math.min(depth + 2, 6)
      lines.push(`${'#'.repeat(hLevel)} ${key}`)
      lines.push(arrayToMd(value))
      lines.push('')
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const hLevel = Math.min(depth + 2, 6)
      lines.push(`${'#'.repeat(hLevel)} ${key}`)
      lines.push(objectToMd(value, depth + 1))
      lines.push('')
    } else if (Array.isArray(value)) {
      lines.push(`**${key}**: ${value.join(', ')}`)
    } else {
      lines.push(`**${key}**: ${formatValue(key, value)}`)
    }
  }
  return lines.join('\n')
}

// --- Array rendering: table or list ---

function arrayToMd(arr) {
  const keySet = new Set()
  for (const obj of arr) {
    if (typeof obj === 'object' && obj !== null) {
      for (const k of Object.keys(obj)) {
        if (!OMIT_KEYS.has(k)) keySet.add(k)
      }
    }
  }
  const keys = [...keySet]
  if (keys.length === 0) return '(empty)'

  const activeKeys = keys.filter(k =>
    arr.some(obj => obj[k] !== null && obj[k] !== undefined)
  )
  if (activeKeys.length === 0) return '(empty)'

  // Merge title+link into single column for table display
  const hasTitle = activeKeys.includes('title')
  const hasLink = activeKeys.includes('link')
  const hasName = activeKeys.includes('name')
  const hasUrl = activeKeys.includes('url')

  // >6 active columns, long text, or nested composite fields -> list format
  if (activeKeys.length > 6 || arr.some(obj =>
    activeKeys.some(k =>
      hasNestedComposite(obj[k]) ||
      String(obj[k] ?? '').length > 120 ||
      String(obj[k] ?? '').includes('\n')
    )
  )) {
    return arrayToList(arr, activeKeys)
  }

  return arrayToTable(arr, activeKeys, { hasTitle, hasLink, hasName, hasUrl })
}

// --- Table format (compact, for small uniform data) ---

function arrayToTable(arr, activeKeys, { hasTitle, hasLink, hasName, hasUrl }) {
  // Build display columns: merge title+link or name+url
  const displayCols = []
  const seen = new Set()

  for (const k of activeKeys) {
    if (seen.has(k)) continue
    if (k === 'title' && hasLink) {
      displayCols.push({ header: 'title', render: obj => mdLink(obj.title, obj.link) })
      seen.add('title')
      seen.add('link')
    } else if (k === 'link' && hasTitle) {
      continue // already merged
    } else if (k === 'name' && hasUrl) {
      displayCols.push({ header: 'name', render: obj => mdLink(obj.name, obj.url) })
      seen.add('name')
      seen.add('url')
    } else if (k === 'url' && hasName) {
      continue
    } else {
      displayCols.push({ header: k, render: obj => cellValue(obj[k]) })
      seen.add(k)
    }
  }

  const header = '| ' + displayCols.map(c => c.header).join(' | ') + ' |'
  const sep = '| ' + displayCols.map(() => '---').join(' | ') + ' |'
  const rows = arr.map(obj =>
    '| ' + displayCols.map(c => c.render(obj)).join(' | ') + ' |'
  )
  return [header, sep, ...rows].join('\n')
}

// --- List format (detailed, for entries with many fields) ---

function arrayToList(arr, activeKeys) {
  return arr.map((obj, i) => {
    const label = obj.title || obj.name || `#${i + 1}`
    const link = obj.link || obj.url
    const heading = link ? `### ${i + 1}. [${label}](${link})` : `### ${i + 1}. ${label}`
    const lines = [heading]

    for (const k of activeKeys) {
      const v = obj[k]
      if (v === null || v === undefined) continue
      if (k === 'title' || k === 'name' || k === 'link' || k === 'url') continue
      if (Array.isArray(v) && !hasNestedComposite(v)) {
        lines.push(`- **${k}**: ${v.join(', ')}`)
      } else if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
        lines.push(`- **${k}**:`)
        lines.push(indentBlock(json2md(v), '  '))
      } else {
        lines.push(`- **${k}**: ${formatValue(k, v)}`)
      }
    }
    return lines.join('\n')
  }).join('\n\n')
}

// --- Helpers ---

function mdLink(text, url) {
  if (!url) return text || ''
  return `[${(text || url).replace(/\|/g, '\\|')}](${url})`
}

function formatValue(key, v) {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v)
  // Shorten ISO dates to YYYY-MM-DD HH:MM
  if (key === 'published' && typeof v === 'string' && v.includes('T')) {
    return v.replace(/T(\d{2}:\d{2}):\d{2}\.\d+Z$/, ' $1Z').replace(/T(\d{2}:\d{2}):\d{2}Z$/, ' $1Z')
  }
  if (URL_KEYS.has(key) && typeof v === 'string') {
    return `<${v}>`
  }
  return String(v)
}

function cellValue(v) {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) {
    if (hasNestedComposite(v)) return JSON.stringify(v)
    return v.join(', ')
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function hasNestedComposite(v) {
  if (Array.isArray(v)) return v.some(item => typeof item === 'object' && item !== null)
  return typeof v === 'object' && v !== null
}

function indentBlock(text, prefix) {
  return String(text)
    .split('\n')
    .map(line => line ? `${prefix}${line}` : line)
    .join('\n')
}
