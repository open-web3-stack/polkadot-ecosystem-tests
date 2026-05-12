#!/usr/bin/env node
//
// Read `endpoint-probe.json` (produced by scripts/probe-endpoints.mjs) and
// rewrite `packages/networks/src/pet-chain-endpoints.json` in-place with each
// chain's endpoint list sorted by ascending health score (best first).
//
// Policy: sort, never filter.
//
// Removing a poorly-scoring endpoint from the list would destroy the failover
// ladder that both Subway and Chopsticks/polkadot.js rely on: when the active
// endpoint stalls or disconnects, both layers fall through to the next entry
// in the array. Keeping bad endpoints at the back of the list means a chain
// pool that has a single working endpoint at probe time still has somewhere
// to escape to if that single endpoint goes bad between probes.
//
// Inputs:
//   endpoint-probe.json (default; override with PROBE_PATH=<path>)
//   packages/networks/src/pet-chain-endpoints.json
// Output:
//   packages/networks/src/pet-chain-endpoints.json (overwritten in-place)
// Exit status:
//   0 if the file already matched the desired order (no changes needed)
//   0 if the file was rewritten
//   2 if endpoint-probe.json is missing or malformed
//   3 if the probe contains chains the endpoints JSON doesn't know about,
//     or vice versa (signal mismatch; bail rather than silently drop)

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const PROBE_PATH = process.env.PROBE_PATH ?? path.join(REPO_ROOT, 'endpoint-probe.json')
const ENDPOINTS_PATH = path.join(REPO_ROOT, 'packages/networks/src/pet-chain-endpoints.json')

function die(code, msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

if (!fs.existsSync(PROBE_PATH)) {
  die(2, `probe file not found: ${PROBE_PATH}\nRun \`node scripts/probe-endpoints.mjs\` first.`)
}

let probe
try {
  probe = JSON.parse(fs.readFileSync(PROBE_PATH, 'utf8'))
} catch (e) {
  die(2, `malformed probe JSON: ${e.message}`)
}

const original = JSON.parse(fs.readFileSync(ENDPOINTS_PATH, 'utf8'))

// Chain-set invariant: the probe must cover exactly the chains in the
// endpoints JSON (and vice versa). Either side adding or removing a chain
// is a deliberate human decision (new parachain onboarded, deprecated
// chain pruned) and should not happen silently as a side effect of running
// this script. Bail with exit 3 so the cron workflow surfaces the
// mismatch rather than committing a half-applied ranking.
const probeChains = new Set(Object.keys(probe))
const endpointsChains = new Set(Object.keys(original))

const missingFromProbe = [...endpointsChains].filter((c) => !probeChains.has(c))
const extraInProbe = [...probeChains].filter((c) => !endpointsChains.has(c))
if (missingFromProbe.length || extraInProbe.length) {
  if (missingFromProbe.length) {
    process.stderr.write(`! probe is missing chains: ${missingFromProbe.join(', ')}\n`)
  }
  if (extraInProbe.length) {
    process.stderr.write(`! probe has unknown chains: ${extraInProbe.join(', ')}\n`)
  }
  die(3, 'aborting: probe and endpoints JSON disagree on chain set')
}

const reordered = {}
let chainsChanged = 0
for (const chain of Object.keys(original)) {
  const probeResults = probe[chain]?.results ?? []
  const rankedEndpoints = probeResults.map((r) => r.endpoint)
  const originalEndpoints = original[chain]

  // Per-chain safety check: if the probe and the JSON disagree on the
  // endpoint membership for this chain (cardinality or set contents), keep
  // the original order rather than risk dropping an endpoint or inserting
  // an unknown one. This handles the in-between state where a chain has
  // been edited in the JSON between the probe run and this apply step.
  if (rankedEndpoints.length !== originalEndpoints.length) {
    process.stderr.write(
      `! ${chain}: probe has ${rankedEndpoints.length} endpoints, JSON has ${originalEndpoints.length}; keeping original order\n`,
    )
    reordered[chain] = originalEndpoints
    continue
  }

  const probeSet = new Set(rankedEndpoints)
  const originalSet = new Set(originalEndpoints)
  const sameSet =
    probeSet.size === originalSet.size && [...probeSet].every((e) => originalSet.has(e))
  if (!sameSet) {
    process.stderr.write(
      `! ${chain}: probe and JSON endpoint sets differ; keeping original order\n`,
    )
    reordered[chain] = originalEndpoints
    continue
  }

  // Probe results are already sorted ascending by score in probe-endpoints.mjs,
  // so iteration order equals desired array order. Track whether anything
  // actually changed so we can short-circuit the rewrite when no diff exists
  // (avoids spurious commits/PRs from the cron job).
  reordered[chain] = rankedEndpoints
  const sameOrder = rankedEndpoints.every((e, i) => e === originalEndpoints[i])
  if (!sameOrder) chainsChanged++
}

if (chainsChanged === 0) {
  process.stderr.write('# endpoint ranking unchanged; no rewrite needed\n')
  process.exit(0)
}

fs.writeFileSync(ENDPOINTS_PATH, JSON.stringify(reordered, null, 2) + '\n')
process.stderr.write(`# rewrote ${ENDPOINTS_PATH} (${chainsChanged} chain pool(s) reordered)\n`)
