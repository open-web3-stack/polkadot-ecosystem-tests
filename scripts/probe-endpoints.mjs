#!/usr/bin/env node
//
// Probe every RPC endpoint in `packages/networks/src/pet-chain-endpoints.json`
// and emit `endpoint-probe.json` with per-endpoint health stats and a ranking.
//
// Probing model:
// - One WebSocket connection per endpoint, reused for all pings.
// - SAMPLES RPC pings paced across WINDOW_MS, with INFLIGHT concurrent in flight.
// - All chains probed in parallel (each chain pool is independent).
//
// Environment knobs (all optional):
//   SAMPLES              (100)   RPC pings per endpoint after connect
//   WINDOW_MS            (10000) wall-clock budget for those pings
//   INFLIGHT             (4)     max concurrent pings per endpoint
//   CONNECT_TIMEOUT_MS   (10000) WS handshake timeout
//   RPC_TIMEOUT_MS       (5000)  per-ping timeout
//   CHAINS               (all)   space-separated chain keys to probe
//   CHAIN_CONCURRENCY    (1)     how many chain pools to probe at once
//   KEEP_PROBE_LOG       (false) keep probe.log alongside JSON

import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const ENDPOINTS = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'packages/networks/src/pet-chain-endpoints.json'), 'utf8'),
)

const SAMPLES = Number(process.env.SAMPLES ?? 100)
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 10_000)
const INFLIGHT = Number(process.env.INFLIGHT ?? 4)
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS ?? 10_000)
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 5_000)
const CHAINS_FILTER = (process.env.CHAINS ?? '').trim().split(/\s+/).filter(Boolean)
const CHAIN_CONCURRENCY = Math.max(1, Number(process.env.CHAIN_CONCURRENCY ?? 1))
const KEEP_PROBE_LOG = ['1', 'true', 'yes'].includes(String(process.env.KEEP_PROBE_LOG ?? '').toLowerCase())

const blockNumbers = (() => {
  const out = {}
  for (const f of ['KNOWN_GOOD_BLOCK_NUMBERS_POLKADOT.env', 'KNOWN_GOOD_BLOCK_NUMBERS_KUSAMA.env']) {
    const p = path.join(REPO_ROOT, f)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)_BLOCK_NUMBER=(\d+)/)
      if (m) out[m[1].toLowerCase().replace(/_/g, '')] = Number(m[2])
    }
  }
  return out
})()

function chainKeyToBlock(chain) {
  return blockNumbers[chain.toLowerCase().replace(/_/g, '')]
}

class WsClient {
  constructor(endpoint) {
    this.endpoint = endpoint
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.connectMs = null
    this.closed = false
  }

  async connect() {
    const started = Date.now()
    this.ws = new WebSocket(this.endpoint, { handshakeTimeout: CONNECT_TIMEOUT_MS })
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS)
      this.ws.once('open', () => {
        clearTimeout(to)
        this.connectMs = Date.now() - started
        resolve()
      })
      this.ws.once('error', (e) => {
        clearTimeout(to)
        reject(e)
      })
    })
    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        const pending = this.pending.get(msg.id)
        if (!pending) return
        this.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) pending.reject(new Error(msg.error.message ?? 'rpc error'))
        else pending.resolve(msg.result)
      } catch {
        /* malformed message; ignore */
      }
    })
    this.ws.on('close', () => {
      this.closed = true
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('ws closed'))
      }
      this.pending.clear()
    })
    this.ws.on('error', () => {
      /* surfaced via close handler; per-call errors raise via timeout/reject */
    })
  }

  call(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('ws closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('rpc timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }))
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  close() {
    try { this.ws?.close() } catch {}
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q))
  return sortedAsc[idx]
}

function stats(arr) {
  const vs = arr.filter((v) => v != null).sort((a, b) => a - b)
  if (vs.length === 0) return null
  return {
    n: vs.length,
    min: vs[0],
    max: vs[vs.length - 1],
    median: quantile(vs, 0.5),
    p95: quantile(vs, 0.95),
    mean: Math.round(vs.reduce((a, b) => a + b, 0) / vs.length),
  }
}

const SYSTEM_NUMBER_KEY = '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7'

async function probeEndpoint(endpoint, blockNumber) {
  const out = {
    endpoint,
    connect_ms: null,
    samples: SAMPLES,
    successes: 0,
    failures: 0,
    ping_ms: [],
    archive_capable: null,
    errors: [],
  }
  const client = new WsClient(endpoint)
  try {
    await client.connect()
    out.connect_ms = client.connectMs
  } catch (e) {
    out.errors.push(`connect: ${e.message}`)
    out.failures = SAMPLES
    return out
  }

  let pinnedHash = null
  if (blockNumber != null) {
    try {
      pinnedHash = await client.call('chain_getBlockHash', [blockNumber])
    } catch (e) {
      out.errors.push(`getBlockHash: ${e.message}`)
    }
  }
  if (pinnedHash) {
    try {
      await client.call('state_getStorage', [SYSTEM_NUMBER_KEY, pinnedHash])
      out.archive_capable = true
    } catch (e) {
      out.archive_capable = false
      out.errors.push(`archive: ${e.message}`)
    }
  }

  const interval = WINDOW_MS / Math.max(SAMPLES, 1)
  const started = Date.now()
  const inflight = new Set()

  for (let i = 0; i < SAMPLES; i++) {
    while (inflight.size >= INFLIGHT) {
      await Promise.race(inflight)
    }
    const targetTime = started + i * interval
    const sleepFor = targetTime - Date.now()
    if (sleepFor > 0) await delay(sleepFor)

    const t0 = Date.now()
    const method =
      pinnedHash && i % 3 === 2
        ? 'state_getStorage'
        : i % 2 === 0
          ? 'chain_getHeader'
          : 'chain_getBlockHash'
    const params =
      method === 'state_getStorage'
        ? [SYSTEM_NUMBER_KEY, pinnedHash]
        : method === 'chain_getBlockHash'
          ? [blockNumber ?? 0]
          : []
    const p = client
      .call(method, params)
      .then(() => {
        out.successes++
        out.ping_ms.push(Date.now() - t0)
      })
      .catch((e) => {
        out.failures++
        out.errors.push(`${method}: ${e.message}`)
      })
      .finally(() => inflight.delete(p))
    inflight.add(p)
  }
  await Promise.all(inflight)
  client.close()
  return out
}

function score(endpointStats) {
  const { samples, failures, successes } = endpointStats
  if (samples === 0 || successes === 0) return Number.POSITIVE_INFINITY
  const lossPct = (failures / samples) * 100
  const lossPenalty = lossPct * 50
  const archivePenalty = endpointStats.archive_capable === false ? 5_000 : 0
  const pingStats = stats(endpointStats.ping_ms)
  const p95 = pingStats?.p95 ?? 99_999
  return Math.round(p95 + lossPenalty + archivePenalty)
}

async function probeChain(chain, endpoints) {
  const blockNumber = chainKeyToBlock(chain)
  const results = await Promise.all(endpoints.map((e) => probeEndpoint(e, blockNumber)))
  for (const r of results) r._score = score(r)
  results.sort((a, b) => a._score - b._score)
  return { chain, blockNumber, results }
}

function fmt(s) {
  if (!s) return '—'
  return `med=${s.median}ms p95=${s.p95}ms`
}

function logChainSummary(out) {
  process.stderr.write(`\n## ${out.chain} (block: ${out.blockNumber ?? 'unknown'})\n`)
  process.stderr.write('rank  score  loss  archive  ping             connect    endpoint\n')
  out.results.forEach((e, idx) => {
    const lossPct = e.samples ? ((e.failures / e.samples) * 100).toFixed(0) : '?'
    process.stderr.write(
      `${String(idx + 1).padStart(4)}  ${String(e._score).padStart(5)}  ` +
        `${String(lossPct).padStart(3)}%  ` +
        `${String(e.archive_capable).padEnd(7)}  ` +
        `${fmt(stats(e.ping_ms)).padEnd(15)}  ` +
        `${String(e.connect_ms ?? '—').padStart(5)}ms  ` +
        `${e.endpoint}\n`,
    )
    if (e.errors.length) {
      const top = [...new Set(e.errors)].slice(0, 3)
      for (const err of top) process.stderr.write(`        ! ${err}\n`)
    }
  })
}

async function main() {
  const chains = CHAINS_FILTER.length ? CHAINS_FILTER : Object.keys(ENDPOINTS)
  process.stderr.write(
    `# Probe config: SAMPLES=${SAMPLES} WINDOW_MS=${WINDOW_MS} INFLIGHT=${INFLIGHT} ` +
      `RPC_TIMEOUT_MS=${RPC_TIMEOUT_MS} CONNECT_TIMEOUT_MS=${CONNECT_TIMEOUT_MS} ` +
      `CHAIN_CONCURRENCY=${CHAIN_CONCURRENCY}\n`,
  )
  process.stderr.write(`# Probing ${chains.length} chains (${CHAIN_CONCURRENCY} at a time)\n`)

  const startedAt = Date.now()
  const output = {}
  const queue = [...chains]
  const runners = Array.from({ length: Math.min(CHAIN_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const chain = queue.shift()
      const endpoints = ENDPOINTS[chain]
      if (!endpoints) {
        process.stderr.write(`! unknown chain: ${chain}\n`)
        continue
      }
      const r = await probeChain(chain, endpoints)
      logChainSummary(r)
      output[chain] = r
    }
  })
  await Promise.all(runners)
  const elapsedMs = Date.now() - startedAt

  fs.writeFileSync(path.join(REPO_ROOT, 'endpoint-probe.json'), JSON.stringify(output, null, 2))
  process.stderr.write(`\n# Done in ${elapsedMs}ms. Wrote endpoint-probe.json\n`)
  if (KEEP_PROBE_LOG) {
    process.stderr.write(`# probe.log preserved (KEEP_PROBE_LOG=true)\n`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
