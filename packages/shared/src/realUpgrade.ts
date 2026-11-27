import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, type Client, createNetworks, defaultAccountsSr25519 } from '@e2e-test/networks'

import { compactAddLength, u8aToHex } from '@polkadot/util'

import { assert } from 'vitest'

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import type { TestConfig } from './helpers/index.js'
import type { RootTestTree } from './types.js'
import { createAndFastTrackReferendum, createXcmAuthorizeUpgradeBatch } from './upgrade.js'

/**
 * Upgrade tests that enact a real release candidate.
 *
 * The other upgrade suites check the machinery: authorize, apply, enact, with the wasm the
 * chain already runs. They prove the wires carry current. This suite upgrades a chain into
 * a candidate runtime it has never run, through a real Root referendum, and then checks the
 * outcome: the chain's code is the candidate's bytes, the spec version moved, migrations
 * drained, and the chain still processes a transaction.
 *
 * The candidate arrives as a file path in `${CHAIN}_CANDIDATE_WASM`, set by a release
 * pipeline from its build artifacts. No artifact, no test: without the variable the test
 * skips. This keeps the suite inert in PET's own CI, which has no candidate to test.
 */

const devAccounts = defaultAccountsSr25519

/** Substrate's 8-byte magic prefix on zstd-compressed runtime blobs. */
const COMPRESSION_MAGIC = Buffer.from([82, 188, 83, 118, 70, 219, 142, 5])

/**
 * Read `spec_name` and `spec_version` out of a runtime wasm, from its `runtime_version`
 * custom section. Decompresses the blob when it carries Substrate's zstd magic. This is
 * what lets the suite name a stale candidate instead of failing opaquely on the runtime's
 * downgrade rejection.
 */
export function candidateRuntimeVersion(blob: Buffer): { specName: string; specVersion: number } {
  const wasm = blob.subarray(0, 8).equals(COMPRESSION_MAGIC) ? zstdDecompressSync(blob.subarray(8)) : blob

  // Minimal wasm section walk: 8-byte header, then sections of (id, varint size, payload).
  // A custom section (id 0) prefixes its payload with a varint-length name.
  let at = 8
  const varint = (): number => {
    let result = 0
    let shift = 0
    for (;;) {
      const byte = wasm[at++]
      result |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7
    }
  }
  while (at < wasm.length) {
    const id = wasm[at++]
    const size = varint()
    const end = at + size
    if (id === 0) {
      const nameLen = varint()
      const name = wasm.subarray(at, at + nameLen).toString()
      at += nameLen
      if (name === 'runtime_version') {
        // SCALE RuntimeVersion: spec_name, impl_name (compact-length strings), then
        // authoring_version and spec_version as u32.
        const compact = (): number => {
          const first = wasm[at]
          if ((first & 0b11) === 0b00) {
            at += 1
            return first >> 2
          }
          if ((first & 0b11) === 0b01) {
            const v = (wasm[at] | (wasm[at + 1] << 8)) >> 2
            at += 2
            return v
          }
          throw new Error('unexpectedly long compact length in runtime_version')
        }
        const specNameLen = compact()
        const specName = wasm.subarray(at, at + specNameLen).toString()
        at += specNameLen
        const implNameLen = compact()
        at += implNameLen
        at += 4 // authoring_version
        const specVersion = wasm.readUInt32LE(at)
        return { specName, specVersion }
      }
    }
    at = end
  }
  throw new Error('no runtime_version section in the candidate wasm')
}

/** Path to the candidate wasm for a chain, or undefined when no pipeline provided one. */
function candidatePath(chain: Chain): string | undefined {
  return process.env[`${chain.name.toUpperCase()}_CANDIDATE_WASM`]
}

/** Build blocks until the predicate holds, up to a bound. Returns whether it held. */
async function buildBlocksUntil(
  client: Client,
  maxBlocks: number,
  predicate: () => Promise<boolean>,
): Promise<boolean> {
  for (let i = 0; i < maxBlocks; i++) {
    if (await predicate()) return true
    await client.dev.newBlock({ count: 1 })
  }
  return await predicate()
}

/** The events of the latest block, as section.method strings. */
async function latestEventNames(client: Client): Promise<string[]> {
  const events = await client.api.query.system.events()
  return events.map(({ event }: any) => `${event.section}.${event.method}`)
}

async function enactCandidate(
  governanceClient: Client,
  targetClient: Client,
  candidate: Uint8Array,
  ctx?: { skip: (reason?: string) => void },
): Promise<void> {
  const alice = devAccounts.alice
  const api = targetClient.api

  const candidateHex = u8aToHex(candidate)
  const candidateHash = api.registry.hash(candidate)

  // Nothing to enact when the chain already runs these exact bytes. A release pipeline hits
  // this when the network enacted the candidate before the gate ran, Westend routinely does.
  const liveCode = await targetClient.chain.head.wasm
  if (liveCode === candidateHex) {
    ctx?.skip?.(`${targetClient.config.name} already runs the candidate`)
    return
  }

  const live = await api.rpc.state.getRuntimeVersion()
  const preVersion = live.specVersion.toNumber()

  // A candidate for the wrong chain is a wiring error; a candidate at or below the live
  // version has nothing to enact, which happens whenever the network enacted a newer weekly
  // than the one under test.
  const declared = candidateRuntimeVersion(Buffer.from(candidate))
  assert.equal(
    declared.specName,
    live.specName.toString(),
    `the candidate declares spec_name ${declared.specName}; the chain runs ${live.specName.toString()}`,
  )
  if (declared.specVersion <= preVersion) {
    ctx?.skip?.(`candidate ${declared.specVersion} is not newer than the live runtime ${preVersion}; nothing to enact`)
    return
  }

  // 1. Authorize the candidate's hash through a real Root referendum on the governance
  // chain. For a remote target the referendum's call is an XCM Transact carrying
  // `authorize_upgrade` to the target. Approval happens by storage write where the pallet cannot progress:
  // see createAndFastTrackReferendum's option.
  const isSelf = governanceClient.config.name === targetClient.config.name
  const authorizeCall = isSelf
    ? governanceClient.api.tx.system.authorizeUpgrade(candidateHash)
    : createXcmAuthorizeUpgradeBatch(candidateHash.toHex() as `0x${string}`, governanceClient, targetClient)

  await createAndFastTrackReferendum(
    governanceClient,
    authorizeCall,
    { system: 'Root' },
    governanceClient.config.properties.schedulerBlockProvider,
    { approvalViaStorage: true },
  )

  // 2. The authorization must be on the target before the apply can validate.
  const authorized = await buildBlocksUntil(targetClient, 3, async () => {
    const entry = await api.query.system.authorizedUpgrade()
    return entry.isSome && entry.unwrap().codeHash.toHex() === candidateHash.toHex()
  })
  assert(authorized, 'the referendum did not authorize the candidate on the target chain')

  // 3. Apply with the candidate's full bytes. The runtime validates the version bump here;
  // a candidate that does not increase the spec version cannot go through the checked path,
  // and that is a finding about the candidate, not a test failure to hide.
  const applyCall = api.tx.system.applyAuthorizedUpgrade(compactAddLength(candidate))
  try {
    await sendTransaction(applyCall.signAsync(alice))
  } catch (e: any) {
    assert.fail(`applyAuthorizedUpgrade was rejected at the transaction pool: ${e.message}`)
  }
  await targetClient.dev.newBlock({ count: 1 })

  // The apply either stores the new code or names the reason it cannot. Surface a dispatch
  // error verbatim: a candidate that cannot be applied is a finding, not a flake.
  const applyEvents = await api.query.system.events()
  const applyFailed = applyEvents.find(({ event }: any) => api.events.system.ExtrinsicFailed.is(event))
  if (applyFailed) {
    const err = (applyFailed.event.data as any).dispatchError
    const name = err.isModule ? api.registry.findMetaError(err.asModule).name : err.toString()
    assert.fail(`applyAuthorizedUpgrade failed in-block: ${name}`)
  }

  // 4. Enactment. A parachain stores the new code as pending validation code and switches
  // on the relay's go-ahead, which chopsticks signals while building blocks; a relay chain
  // switches directly. Either way, CodeUpdated marks the switch.
  const seen: string[] = []
  const enacted = await buildBlocksUntil(targetClient, 6, async () => {
    const names = await latestEventNames(targetClient)
    seen.push(names.filter((n) => n.startsWith('parachainSystem.') || n.startsWith('system.')).join(','))
    return names.includes('system.CodeUpdated')
  })
  assert(
    enacted,
    `the upgrade never enacted: no system.CodeUpdated within the block budget; per block: ${seen.join(' | ')}`,
  )

  // 5. Outcome checks. The strongest one first: the chain's code is the candidate, byte for
  // byte. Everything else is corroboration.
  const newCode = await targetClient.chain.head.wasm
  assert(newCode === candidateHex, 'the enacted :code differs from the candidate bytes')

  // `LastRuntimeUpgrade` is written when the new runtime first executes, one block after
  // the switch, so the bookkeeping checks read the state after one more block.
  await targetClient.dev.newBlock({ count: 1 })

  const newVersion = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber()
  assert(newVersion > preVersion, `the spec version did not increase: ${preVersion} -> ${newVersion}`)
  const lastUpgrade = await api.query.system.lastRuntimeUpgrade()
  assert.equal(lastUpgrade.unwrap().specVersion.toNumber(), newVersion)

  // 6. Migrations drain. Single-block migrations ran inside the enactment block; multi-block
  // migrations hold a cursor until they finish.
  if (api.query.multiBlockMigrations?.cursor) {
    const drained = await buildBlocksUntil(
      targetClient,
      20,
      async () => (await api.query.multiBlockMigrations.cursor()).isNone,
    )
    assert(drained, 'multi-block migrations still hold a cursor after 20 blocks')
  }

  // 7. The chain still works: one signed transfer, executed on the new runtime.
  const transfer = api.tx.balances.transferKeepAlive(devAccounts.bob.address, 1_000_000n)
  await sendTransaction(transfer.signAsync(alice))
  await targetClient.dev.newBlock({ count: 1 })
  const names = await latestEventNames(targetClient)
  assert(names.includes('balances.Transfer'), `no balances.Transfer on the upgraded runtime; saw: ${names.join(', ')}`)
}

async function realUpgradeTest(
  governanceChain: Chain,
  targetChain: Chain,
  ctx?: { skip: (reason?: string) => void },
): Promise<void> {
  const path = candidatePath(targetChain)
  if (!path) {
    ctx?.skip?.(`no candidate artifact: ${targetChain.name.toUpperCase()}_CANDIDATE_WASM is not set`)
    return
  }
  const candidate = readFileSync(path)

  let governanceClient: Client
  let targetClient: Client
  if (governanceChain.name === targetChain.name) {
    ;[governanceClient] = await createNetworks(governanceChain)
    targetClient = governanceClient
  } else {
    ;[governanceClient, targetClient] = await createNetworks(governanceChain, targetChain)
  }

  try {
    await enactCandidate(governanceClient, targetClient, candidate, ctx)
  } finally {
    await governanceClient.api.disconnect().catch(() => {})
    await governanceClient.teardown().catch(() => {})
    if (targetClient !== governanceClient) {
      await targetClient.api.disconnect().catch(() => {})
      await targetClient.teardown().catch(() => {})
    }
  }
}

/**
 * One test: the governance chain enacts a candidate runtime on the target chain through a
 * real Root referendum, and the target provably runs it afterwards. `governanceChain` and
 * `targetChain` may be the same chain (self-upgrade).
 */
export function realUpgradeE2ETests(governanceChain: Chain, targetChain: Chain, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: `enacts the candidate runtime on ${targetChain.name} via Root referendum`,
        testFn: async (ctx) => await realUpgradeTest(governanceChain, targetChain, ctx),
      },
    ],
  }
}
