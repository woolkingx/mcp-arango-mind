// env.mjs — Load .env file, merge ARANGO_* env vars into profile config
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ObjectTree } from './lib/schema2object.mjs'

const __dirname = dirname(dirname(fileURLToPath(import.meta.url)))

let _schema = null
function getSchema() {
  if (!_schema) {
    _schema = JSON.parse(readFileSync(resolve(__dirname, 'config/arango-connection.json'), 'utf-8'))
  }
  return _schema
}

/** Parse .env file into key=value pairs. Ignores comments and blank lines. */
function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {}
  const vars = {}
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    vars[key] = val
  }
  return vars
}

/**
 * Load environment: .env file → process.env → merge into profile.
 * ARANGO_URL, ARANGO_DB, ARANGO_USERNAME, ARANGO_PASSWORD override profile values.
 */
export function loadEnv(envPath) {
  const filePath = envPath || resolve(__dirname, '.env')
  const fileVars = parseEnvFile(filePath)
  // .env values → process.env (don't override existing env)
  for (const [k, v] of Object.entries(fileVars)) {
    if (process.env[k] === undefined) process.env[k] = v
  }
}

/** Build profile config from env vars. Returns partial — merge with profile. */
export function profileFromEnv() {
  const p = {}
  if (process.env.ARANGO_URL) p.url = process.env.ARANGO_URL
  if (process.env.ARANGO_DB) p.database = process.env.ARANGO_DB
  if (process.env.ARANGO_USERNAME || process.env.ARANGO_PASSWORD) {
    p.auth = {
      username: process.env.ARANGO_USERNAME || 'root',
      password: process.env.ARANGO_PASSWORD || ''
    }
  }
  if (process.env.ARANGO_TOKEN) {
    p.auth = { token: process.env.ARANGO_TOKEN }
  }
  if (process.env.ARANGO_LOG_LEVEL) p.logLevel = process.env.ARANGO_LOG_LEVEL
  return p
}

/** Merge profile with env overrides. Env wins. Auth uses oneOf schema to enforce shape. */
export function resolveProfile(profile) {
  const env = profileFromEnv()
  // Env auth replaces profile auth entirely (oneOf: Basic OR Bearer, never mixed)
  const auth = env.auth || profile.auth
  const merged = { ...profile, ...env, auth }
  // Validate auth shape via ObjectTree + AuthCredentials oneOf
  if (auth) {
    const schema = getSchema()
    const authSchema = { $ref: '#/definitions/AuthCredentials', definitions: schema.definitions }
    new ObjectTree(auth, authSchema) // throws if auth is mixed shape
  }
  return merged
}

/** Write a key=value to .env file. Updates existing key or appends new one. */
export function saveEnv(key, value, envPath) {
  const filePath = envPath || resolve(__dirname, '.env')
  const lines = existsSync(filePath) ? readFileSync(filePath, 'utf-8').split('\n') : []
  let found = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('#') || !trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    if (trimmed.slice(0, eq).trim() === key) {
      lines[i] = `${key}=${value}`
      found = true
      break
    }
  }
  if (!found) lines.push(`${key}=${value}`)
  writeFileSync(filePath, lines.join('\n'))
  process.env[key] = value
}
