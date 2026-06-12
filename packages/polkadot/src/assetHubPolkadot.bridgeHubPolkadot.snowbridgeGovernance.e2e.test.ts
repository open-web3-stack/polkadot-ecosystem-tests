import { sendTransaction } from '@acala-network/chopsticks-testing'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, bridgeHubPolkadot } from '@e2e-test/networks/chains'
import { assertExpectedEvents, scheduleLookupCallWithOrigin, setupNetworks } from '@e2e-test/shared'
import reference from '@e2e-test/shared/snowbridge/referencePreimages.json' with { type: 'json' }

import { hexToU8a } from '@polkadot/util'
import { blake2AsHex } from '@polkadot/util-crypto'

import { describe, expect, test } from 'vitest'

// Executes the version-controlled Snowbridge halt/resume governance preimage against
// forked Asset Hub + Bridge Hub and asserts the bridge halts and resumes. Lets an
// operator trust a generated preimage by comparing its hash against this repo.

const MAX_U128 = (1n << 128n) - 1n

// twox_128(":BridgeHubEthereumBaseFee:") / twox_128(":BridgeHubEthereumBaseFeeV2:").
const FEE_KEY_V1 = '0x5fbc5c7ba58845ad1f1a9a7c5bc12fad'
const FEE_KEY_V2 = '0xd0ed50b03e9a49e836dd934b425ba4c3'

// Gateway V1/V2 (ethereumSystem / ethereumSystemV2) have no local operatingMode: their
// setOperatingMode enqueues an outbound command, covered by messageQueue.Processed below.
const BH_OPERATING_MODE_PALLETS = [
  'ethereumInboundQueue',
  'ethereumInboundQueueV2',
  'ethereumOutboundQueue',
  'ethereumBeaconClient',
] as const

type PreimageEntry = { hash: string; callData: string }

describe('Snowbridge governance halt/resume preimage', async () => {
  const [assetHub, bridgeHub] = await setupNetworks(assetHubPolkadot, bridgeHubPolkadot)
  const blockProvider = assetHub.config.properties.schedulerBlockProvider

  async function readFeeU128(key: string): Promise<bigint> {
    const raw = await assetHub.api.rpc.state.getStorage(key)
    return assetHub.api.createType('u128', hexToU8a((raw as any).toHex())).toBigInt()
  }

  async function bridgeHubOperatingModes(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const p of BH_OPERATING_MODE_PALLETS) {
      out[p] = (await (bridgeHub.api.query as any)[p].operatingMode()).toString()
    }
    return out
  }

  const bhModeChangedEvents = (mode: string) =>
    BH_OPERATING_MODE_PALLETS.map((p) => ({
      type: (bridgeHub.api.events as any)[p].OperatingModeChanged,
      args: { mode },
    }))

  async function dispatchPreimageAsRoot(entry: PreimageEntry): Promise<void> {
    await assetHub.dev.setStorage({
      System: {
        account: [[[defaultAccounts.alice.address], { providers: 1, data: { free: 10000n * 10n ** 10n } }]],
      },
    })
    await sendTransaction(assetHub.api.tx.preimage.notePreimage(entry.callData).signAsync(defaultAccounts.alice))
    await assetHub.dev.newBlock()
    const len = (entry.callData.length - 2) / 2
    await scheduleLookupCallWithOrigin(assetHub, { hash: entry.hash, len }, { system: 'Root' }, blockProvider)
    await assetHub.dev.newBlock()
  }

  test('reference hashes match reference bytes', () => {
    expect(blake2AsHex(reference.halt.callData, 256)).toBe(reference.halt.hash)
    expect(blake2AsHex(reference.resume.callData, 256)).toBe(reference.resume.hash)
  })

  test('committed halt preimage halts the bridge; resume restores it', async () => {
    // Halt
    await dispatchPreimageAsRoot(reference.halt)
    assertExpectedEvents(await assetHub.api.query.system.events(), [
      { type: assetHub.api.events.polkadotXcm.Sent },
      { type: assetHub.api.events.snowbridgeSystemFrontend.ExportOperatingModeChanged, args: { mode: 'Halted' } },
    ])
    expect((await assetHub.api.query.snowbridgeSystemFrontend.exportOperatingMode()).toString()).toBe('Halted')
    expect(await readFeeU128(FEE_KEY_V1)).toBe(MAX_U128)
    expect(await readFeeU128(FEE_KEY_V2)).toBe(MAX_U128)

    await bridgeHub.dev.newBlock()
    // success: true proves every Transact ran, including the two gateway commands.
    assertExpectedEvents(await bridgeHub.api.query.system.events(), [
      { type: bridgeHub.api.events.messageQueue.Processed, args: { success: true } },
      ...bhModeChangedEvents('Halted'),
    ])
    expect(await bridgeHubOperatingModes()).toEqual({
      ethereumInboundQueue: 'Halted',
      ethereumInboundQueueV2: 'Halted',
      ethereumOutboundQueue: 'Halted',
      ethereumBeaconClient: 'Halted',
    })

    // Resume
    await dispatchPreimageAsRoot(reference.resume)
    assertExpectedEvents(await assetHub.api.query.system.events(), [
      { type: assetHub.api.events.polkadotXcm.Sent },
      { type: assetHub.api.events.snowbridgeSystemFrontend.ExportOperatingModeChanged, args: { mode: 'Normal' } },
    ])
    expect((await assetHub.api.query.snowbridgeSystemFrontend.exportOperatingMode()).toString()).toBe('Normal')
    expect(await readFeeU128(FEE_KEY_V1)).toBeLessThan(MAX_U128)
    expect(await readFeeU128(FEE_KEY_V2)).toBeLessThan(MAX_U128)

    await bridgeHub.dev.newBlock()
    assertExpectedEvents(await bridgeHub.api.query.system.events(), [
      { type: bridgeHub.api.events.messageQueue.Processed, args: { success: true } },
      ...bhModeChangedEvents('Normal'),
    ])
    expect(await bridgeHubOperatingModes()).toEqual({
      ethereumInboundQueue: 'Normal',
      ethereumInboundQueueV2: 'Normal',
      ethereumOutboundQueue: 'Normal',
      ethereumBeaconClient: 'Normal',
    })
  })
})
