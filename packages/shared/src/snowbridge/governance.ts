import { sendTransaction } from '@acala-network/chopsticks-testing'

import { defaultAccounts } from '@e2e-test/networks'

import { hexToU8a } from '@polkadot/util'
import { blake2AsHex } from '@polkadot/util-crypto'

import { expect } from 'vitest'

import { assertExpectedEvents, scheduleLookupCallWithOrigin } from '../helpers/index.js'
import type { Client } from '../types.js'
import reference from './referencePreimages.json' with { type: 'json' }

/**
 * Snowbridge governance halt/resume tests.
 *
 * Snowbridge can be paused ("halted") and unpaused ("resumed") by governance. In production this is
 * done by enacting a single, pre-built governance preimage. Because that preimage is the artifact an
 * operator would actually submit in an emergency, this repo keeps a copy of it under version control
 * (`referencePreimages.json`) so it can be reviewed, hashed, and tested against mainnet, end to end.
 *
 * These tests execute that committed preimage against a forked Asset Hub + Bridge Hub and assert that
 * the bridge actually halts and then resumes. The point is to let an operator trust a freshly generated
 * preimage by comparing its hash against the one proven here, rather than blindly submitting bytes.
 *
 * Asset Hub vs Bridge Hub
 * -----------------------
 * The two chains play different roles in the bridge, so the halt has to touch both:
 *   - Bridge Hub contains the actual bridge machinery: the queues that handle messages to and from
 *     Ethereum, the Ethereum client (also called the beacon client in some places, named after Ethereum's
 *     consensus chain, the beacon chain) that tracks Ethereum consensus, and the Ethereum gateway contract
 *     (which is the entry point into Polkadot from Ethereum). This is where messages are accepted,
 *     verified, and dispatched.
 *   - Asset Hub is the user-facing entry point for P->E transfers. Users initiate a message from Asset
 *     Hub, and Asset Hub charges them the export base fee before forwarding the message (via XCM) to
 *     Bridge Hub.
 *
 * So a full halt sends an XCM from Asset Hub to Bridge Hub to stop the bridge machinery, and also halts the
 * Asset Hub frontend + increases fees to the max value, so no new exports are even accepted upstream.
 *
 * V1 vs V2
 * --------
 * Snowbridge is mid-migration from a V1 protocol to a V2 protocol, and both run in parallel during the
 * transition. Each version has its own inbound queue, gateway, and export base-fee key, so a complete halt
 * must cover both: halting only one version would leave the other path open.
 *
 * What the halt preimage does (a `utility.forceBatch` enacted as Root on Asset Hub):
 *   1. Sends an XCM to Bridge Hub that, in a nested batch, sets `operatingMode = Halted` on the inbound
 *      queues (V1 + V2), the outbound queue, the beacon client, and both Ethereum gateways (V1 + V2). This
 *      stops traffic in both directions: inbound (Ethereum -> Polkadot) is blocked by halting the inbound
 *      queues and freezing the beacon client (no consensus updates means inbound messages can't be proven),
 *      and outbound (Polkadot -> Ethereum) is blocked by halting the outbound queue and the gateways.
 *   2. Sets the Asset Hub Snowbridge frontend export operating mode to `Halted`, blocking new exports.
 *   3. Overwrites both export base-fee storage items (V1 + V2) with `u128::MAX`, so any export that slips
 *      through is economically impossible. This is defense-in-depth on top of step 2.
 *
 * The resume preimage is the symmetric inverse: it sets every operating mode back to `Normal` and
 * restores the base fees to sane values.
 */

/** Largest u128 value; the halt preimage sets the bridge base fees to this to make message prohibitively expensive. */
const MAX_U128 = (1n << 128n) - 1n

// Asset Hub storage keys for the Snowbridge export base fee (V1 + V2), addressed directly because they are
// not exposed as typed storage items. Each is `twox_128(":BridgeHubEthereumBaseFee:")` (V1) and
// `twox_128(":BridgeHubEthereumBaseFeeV2:")` (V2).
//
// This fee is the per-message price Asset Hub charges a user to export to Ethereum. The halt pins it to
// `u128::MAX`, which no account can pay, so the export is rejected on the fee check before it is ever
// forwarded to Bridge Hub. That is why writing this value halts (the outbound side of) the bridge.
const FEE_KEY_V1 = '0x5fbc5c7ba58845ad1f1a9a7c5bc12fad'
const FEE_KEY_V2 = '0xd0ed50b03e9a49e836dd934b425ba4c3'

// Bridge Hub pallets that expose a local `operatingMode` storage item we can read back to confirm the halt.
//
// Note the Gateway pallets V1/V2 (`ethereumSystem` / `ethereumSystemV2`) are deliberately absent: they have
// no local `operatingMode`. Their `setOperatingMode` instead enqueues an outbound command, which is covered
// by the `messageQueue.Processed` assertion rather than a storage read.
const BH_OPERATING_MODE_PALLETS = [
  'ethereumInboundQueue',
  'ethereumInboundQueueV2',
  'ethereumOutboundQueue',
  'ethereumBeaconClient',
] as const

type PreimageEntry = { hash: string; callData: string }

/** Read a raw Asset Hub storage key and decode it as a u128. */
async function readFeeU128(assetHub: Client<any, any>, key: string): Promise<bigint> {
  const raw = await assetHub.api.rpc.state.getStorage(key)
  return assetHub.api.createType('u128', hexToU8a((raw as any).toHex())).toBigInt()
}

/** Read every Bridge Hub `operatingMode` of interest into a `{ pallet: mode }` map. */
async function bridgeHubOperatingModes(bridgeHub: Client<any, any>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const p of BH_OPERATING_MODE_PALLETS) {
    out[p] = (await (bridgeHub.api.query as any)[p].operatingMode()).toString()
  }
  return out
}

/** Expected `OperatingModeChanged` events, one per Bridge Hub pallet, for the given mode. */
const bhModeChangedEvents = (bridgeHub: Client<any, any>, mode: string) =>
  BH_OPERATING_MODE_PALLETS.map((p) => ({
    type: (bridgeHub.api.events as any)[p].OperatingModeChanged,
    args: { mode },
  }))

/**
 * Enact one preimage entry as Root on Asset Hub.
 *
 * Mirrors what governance does: fund a submitter, note the preimage on chain, then schedule a Root-origin
 * `Lookup` call referencing it so it executes in the next block.
 */
async function dispatchPreimageAsRoot(assetHub: Client<any, any>, entry: PreimageEntry): Promise<void> {
  const blockProvider = assetHub.config.properties.schedulerBlockProvider
  await assetHub.dev.setStorage({
    System: {
      account: [[[defaultAccounts.alice.address], { providers: 1, data: { free: 10000n * 10n ** 10n } }]],
    },
  })
  await sendTransaction(assetHub.api.tx.preimage.notePreimage(entry.callData).signAsync(defaultAccounts.alice))
  await assetHub.dev.newBlock()
  // Preimage length in bytes: hex string minus the "0x" prefix, 2 chars per byte.
  const len = (entry.callData.length - 2) / 2
  await scheduleLookupCallWithOrigin(assetHub, { hash: entry.hash, len }, { system: 'Root' }, blockProvider)
  await assetHub.dev.newBlock()
}

/**
 * Sanity check on the committed reference data itself: hashing the stored call bytes must reproduce the
 * stored hash. This guards against the JSON drifting (e.g. bytes edited without regenerating the hash),
 * which would silently invalidate any operator who trusts the hash.
 */
export function verifyReferencePreimageHashes(): void {
  expect(blake2AsHex(reference.halt.callData, 256)).toBe(reference.halt.hash)
  expect(blake2AsHex(reference.resume.callData, 256)).toBe(reference.resume.hash)
}

/**
 * Full halt-then-resume round trip.
 *
 * Halt: enact the committed halt preimage on Asset Hub and assert the export operating mode flips to
 * `Halted`, both base fees are pushed to `MAX_U128`, and the resulting XCM lands on Bridge Hub where every
 * queued command processes successfully and each pallet's `operatingMode` reads back as `Halted`.
 *
 * Resume: enact the committed resume preimage and assert the symmetric reversal: mode back to `Normal`,
 * fees back below `MAX_U128`, and every Bridge Hub pallet `Normal` again.
 */
export async function snowbridgeHaltResumeTest(assetHub: Client<any, any>, bridgeHub: Client<any, any>): Promise<void> {
  // Halt
  await dispatchPreimageAsRoot(assetHub, reference.halt)
  assertExpectedEvents(await assetHub.api.query.system.events(), [
    { type: assetHub.api.events.polkadotXcm.Sent },
    { type: assetHub.api.events.snowbridgeSystemFrontend.ExportOperatingModeChanged, args: { mode: 'Halted' } },
  ])
  expect((await assetHub.api.query.snowbridgeSystemFrontend.exportOperatingMode()).toString()).toBe('Halted')
  expect(await readFeeU128(assetHub, FEE_KEY_V1)).toBe(MAX_U128)
  expect(await readFeeU128(assetHub, FEE_KEY_V2)).toBe(MAX_U128)

  await bridgeHub.dev.newBlock()
  // success: true proves every Transact ran, including the two gateway commands.
  assertExpectedEvents(await bridgeHub.api.query.system.events(), [
    { type: bridgeHub.api.events.messageQueue.Processed, args: { success: true } },
    ...bhModeChangedEvents(bridgeHub, 'Halted'),
  ])
  expect(await bridgeHubOperatingModes(bridgeHub)).toEqual({
    ethereumInboundQueue: 'Halted',
    ethereumInboundQueueV2: 'Halted',
    ethereumOutboundQueue: 'Halted',
    ethereumBeaconClient: 'Halted',
  })

  // Resume
  await dispatchPreimageAsRoot(assetHub, reference.resume)
  assertExpectedEvents(await assetHub.api.query.system.events(), [
    { type: assetHub.api.events.polkadotXcm.Sent },
    { type: assetHub.api.events.snowbridgeSystemFrontend.ExportOperatingModeChanged, args: { mode: 'Normal' } },
  ])
  expect((await assetHub.api.query.snowbridgeSystemFrontend.exportOperatingMode()).toString()).toBe('Normal')
  expect(await readFeeU128(assetHub, FEE_KEY_V1)).toBeLessThan(MAX_U128)
  expect(await readFeeU128(assetHub, FEE_KEY_V2)).toBeLessThan(MAX_U128)

  await bridgeHub.dev.newBlock()
  assertExpectedEvents(await bridgeHub.api.query.system.events(), [
    { type: bridgeHub.api.events.messageQueue.Processed, args: { success: true } },
    ...bhModeChangedEvents(bridgeHub, 'Normal'),
  ])
  expect(await bridgeHubOperatingModes(bridgeHub)).toEqual({
    ethereumInboundQueue: 'Normal',
    ethereumInboundQueueV2: 'Normal',
    ethereumOutboundQueue: 'Normal',
    ethereumBeaconClient: 'Normal',
  })
}
