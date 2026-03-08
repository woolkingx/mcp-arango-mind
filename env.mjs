// env.mjs — Load .env file, merge ARANGO_* env vars into profile config
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

/** Merge profile with env overrides. Env wins. */
export function resolveProfile(profile) {
  const env = profileFromEnv()
  return { ...profile, ...env, auth: { ...profile.auth, ...env.auth } }
}
