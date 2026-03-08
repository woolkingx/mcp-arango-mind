/**
 * Transport layer for ArangoDB — queue, retry, failover, auth.
 * Replaces pool.mjs. Ported from arangojs connection.ts, simplified for ES modules.
 *
 * Public API: createConnection(config) → { request, close, getActiveHostUrl, setAuth, setTransactionId }
 * request(method, path, opts?) → { status, data }
 */
import { readFileSync } from 'node:fs';
import { NetworkError, ResponseTimeoutError, FetchFailedError } from './errors.mjs';
import { ObjectTree } from './lib/schema2object.mjs';

const LEADER_ENDPOINT_HEADER = 'x-arango-endpoint';
const QUEUE_TIME_HEADER = 'x-arango-queue-time-seconds';
const MIME_JSON = /\/(json|javascript)(\W|$)/;
const ERROR_ARANGO_CONFLICT = 1200;

let _schema = null;
function getSchema() {
  if (!_schema) {
    _schema = JSON.parse(readFileSync(
      new URL('../config/arango-connection.json', import.meta.url), 'utf-8'
    ));
  }
  return _schema;
}

function normalizeUrl(raw) {
  return raw
    .replace(/^tcp:\/\//, 'http://')
    .replace(/^ssl:\/\//, 'https://')
    .replace(/^tls:\/\//, 'https://')
    .replace(/\/+$/, '');
}

function buildAuthHeader(auth) {
  if (!auth) return null;
  if (auth.token) return `Bearer ${auth.token}`;
  return `Basic ${btoa(`${auth.username ?? 'root'}:${auth.password ?? ''}`)}`;
}

export function createConnection(config = {}) {
  const schema = getSchema();
  const connSchema = { $ref: '#/definitions/ConnectionConfig', definitions: schema.definitions };
  // Validate + apply schema defaults — no hardcoded values needed
  const tree = new ObjectTree(config, connSchema);
  const cfg = tree.withDefaults().toDict();

  const rawUrls = Array.isArray(cfg.url) ? cfg.url : [cfg.url];
  const hostUrls = rawUrls.map(normalizeUrl);
  let database = cfg.database;
  let authHeader = buildAuthHeader(cfg.auth);
  const loadBalancing = cfg.loadBalancing;
  let hostIndex = loadBalancing === 'ONE_RANDOM'
    ? Math.floor(Math.random() * hostUrls.length) : 0;
  const poolSize = cfg.poolSize;
  let activeTasks = 0;
  const waitQueue = [];
  const cfgMaxRetries = cfg.maxRetries === false ? 0 : cfg.maxRetries;
  const cfgRetryOnConflict = cfg.retryOnConflict;
  const defaultTimeout = cfg.timeout;
  const queueTimeSamples = cfg.responseQueueTimeSamples;
  const queueTimes = [];
  let transactionId = null;
  const pending = new Set();

  // ── Pool slot management ────────────────────────────────────────────────
  async function acquireSlot() {
    if (activeTasks < poolSize) { activeTasks++; return; }
    await new Promise(resolve => waitQueue.push({ resolve }));
    activeTasks++;
  }
  function releaseSlot() {
    activeTasks--;
    if (waitQueue.length) waitQueue.shift().resolve();
  }

  // ── Single fetch against one host ───────────────────────────────────────
  async function fetchHost(hostUrl, method, path, { headers, body, timeout } = {}) {
    const url = `${hostUrl}${path}`;
    const reqHeaders = { ...headers };
    if (authHeader && !reqHeaders.authorization) reqHeaders.authorization = authHeader;
    if (transactionId) reqHeaders['x-arango-trx-id'] = transactionId;
    let reqBody = body;
    if (body != null && typeof body === 'object') {
      reqBody = JSON.stringify(body);
      if (!reqHeaders['content-type']) reqHeaders['content-type'] = 'application/json';
    }
    const ac = new AbortController();
    pending.add(ac);
    let timer;
    const t = timeout || defaultTimeout;
    if (t > 0) timer = setTimeout(() => ac.abort('timeout'), t);
    try {
      const res = await fetch(url, { method, headers: reqHeaders, body: reqBody, signal: ac.signal });
      const qt = res.headers.get(QUEUE_TIME_HEADER);
      if (qt) {
        queueTimes.push([Date.now(), Number(qt)]);
        while (queueTimes.length > queueTimeSamples) queueTimes.shift();
      }
      const leaderEndpoint = res.headers.get(LEADER_ENDPOINT_HEADER);
      const contentType = res.headers.get('content-type');
      let data;
      if (contentType?.match(MIME_JSON)) data = await res.json();
      else { const text = await res.text(); data = text || null; }
      return { status: res.status, data, leaderEndpoint };
    } catch (err) {
      if (ac.signal.aborted && ac.signal.reason === 'timeout') throw new ResponseTimeoutError();
      if (err instanceof TypeError) throw new FetchFailedError(err.message, { cause: err });
      throw new NetworkError(err.message, { cause: err });
    } finally {
      if (timer) clearTimeout(timer);
      pending.delete(ac);
    }
  }

  // ── Host selection ──────────────────────────────────────────────────────
  function pickHostIndex() {
    if (loadBalancing === 'ROUND_ROBIN') {
      const idx = hostIndex;
      hostIndex = (hostIndex + 1) % hostUrls.length;
      return idx;
    }
    return hostIndex;
  }
  function advanceHost(idx) {
    if (loadBalancing !== 'ROUND_ROBIN') hostIndex = (idx + 1) % hostUrls.length;
  }

  // ── Main request with retry / failover ──────────────────────────────────
  async function request(method, path, opts = {}) {
    const { headers, body, timeout, allowDirtyRead, transactionId: reqTxId } = opts;
    const reqHeaders = { ...headers };
    if (allowDirtyRead) reqHeaders['x-arango-allow-dirty-read'] = 'true';
    const effectiveMaxRetries = cfgMaxRetries || (hostUrls.length - 1);
    const effectiveConflictRetries = opts.retryOnConflict ?? cfgRetryOnConflict;
    let retries = 0, conflicts = 0;
    const savedTxId = transactionId;
    if (reqTxId !== undefined) transactionId = reqTxId;
    try {
      await acquireSlot();
      try {
        while (true) {
          const idx = pickHostIndex();
          let result;
          try {
            result = await fetchHost(hostUrls[idx], method, path, { headers: reqHeaders, body, timeout });
          } catch (err) {
            advanceHost(idx);
            if (err.isSafeToRetry !== false && retries < effectiveMaxRetries) { retries++; continue; }
            throw err;
          }
          // Leader redirect: 503 + x-arango-endpoint → add host, retry
          if (result.status === 503 && result.leaderEndpoint) {
            const newUrl = normalizeUrl(result.leaderEndpoint);
            if (!hostUrls.includes(newUrl)) hostUrls.push(newUrl);
            hostIndex = hostUrls.indexOf(newUrl);
            continue;
          }
          // Write-write conflict retry (errorNum 1200)
          if (result.data?.error === true && result.data?.errorNum === ERROR_ARANGO_CONFLICT
              && conflicts < effectiveConflictRetries) { conflicts++; continue; }
          // Return as-is — dispatch.mjs handles ArangoDB error responses
          return { status: result.status, data: result.data };
        }
      } finally { releaseSlot(); }
    } finally { if (reqTxId !== undefined) transactionId = savedTxId; }
  }

  // ── Public API ──────────────────────────────────────────────────────────
  return {
    request,
    close() {
      for (const ac of pending) { try { ac.abort(); } catch { /* noop */ } }
      pending.clear();
    },
    getActiveHostUrl() { return hostUrls[hostIndex]; },
    getDatabase() { return database; },
    setAuth(auth) { authHeader = buildAuthHeader(auth); },
    setDatabase(db) { database = db; },
    setTransactionId(id) { transactionId = id || null; },
    get queueTime() {
      const latest = queueTimes.length ? queueTimes[queueTimes.length - 1][1] : undefined;
      const values = [...queueTimes];
      const avg = values.length ? values.reduce((s, [, v]) => s + v, 0) / values.length : 0;
      return { latest, values, avg };
    },
  };
}
