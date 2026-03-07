// pool.mjs — HTTP connection pool for ArangoDB (keep-alive)

export function createPool(config) {
  let baseUrl
  let authHeader

  function configure({ url, database, auth }) {
    baseUrl = `${url}/_db/${database}`
    authHeader = 'Basic ' + Buffer.from(auth.username + ':' + auth.password).toString('base64')
  }

  configure(config)

  async function fetch(method, path, { headers = {}, body } = {}) {
    const res = await globalThis.fetch(baseUrl + path, {
      method,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    })
    const data = await res.json()
    return { status: res.status, data }
  }

  function close() {}

  function reconfigure(newConfig) {
    close()
    configure(newConfig)
  }

  function getBaseUrl() {
    return baseUrl
  }

  return { fetch, close, reconfigure, getBaseUrl }
}
