import { type Chain, captureSnapshot, createNetworks } from '@e2e-test/networks'
import { polkadot } from '@e2e-test/networks/chains'

import { afterAll, beforeEach, expect } from 'vitest'

/**
 * Sets up blockchain networks for testing with automatic snapshot restore and cleanup.
 *
 * This function creates test networks for the specified chain types and sets up test fixtures
 * to automatically restore snapshots between tests and clean up when finished.
 *
 * @param chains - Array of Chain type parameters defining which networks to create
 * @returns Promise resolving to array of created network instances
 *
 * @example
 * const [assetHubPolkadotClient, acalaClient] = await setupNetworks(assetHubPolkadot, acala)
 */
export async function setupNetworks<T extends Chain[]>(...chains: T) {
  const networks = await createNetworks(...chains)

  const restoreSnapshot = captureSnapshot(...networks)

  beforeEach(async () => {
    await restoreSnapshot()
    await Promise.all(
      networks.map(async (network) => {
        const blockNumber = (await network.api.rpc.chain.getHeader()).number.toNumber()

        network.dev.setHead(blockNumber)
      }),
    )
  })

  afterAll(async () => {
    await Promise.all(networks.map((network) => network.teardown()))
  })

  return networks
}

export async function setupBalances(client: any, accounts: { address: any; amount: number }[]) {
  for (const { address, amount } of accounts) {
    await client.dev.setStorage({
      System: {
        account: [[[address], { providers: 1, data: { free: amount, frozen: 0, reserved: 0 } }]],
      },
    })

    const account = await client.api.query.system.account(address)
    expect(account.data.free.toNumber(), `User ${address} free balance should be ${amount}`).toBe(amount)
    expect(account.data.frozen.toNumber(), `User ${address} frozen balance should be 0`).toBe(0)
    expect(account.data.reserved.toNumber(), `User ${address} reserved balance should be 0`).toBe(0)
  }
}

/**
 * Sets up blockchain networks for testing with automatic snapshot restore and cleanup.
 *
 * This function creates test networks for the specified chain types and sets up test fixtures
 * to automatically restore snapshots between tests and clean up when finished.
 *
 * @param chains - Array of Chain type parameters defining which networks to create
 * @returns Promise resolving to array of created network instances
 *
 * @example
 * const [assetHubPolkadotClient, acalaClient] = await setupNetworks(assetHubPolkadot, acala)
 */
export async function setupNetworksForAssetHub<T extends Chain[]>(...chains: T) {
  const networks = await createNetworks(...chains, polkadot)

  const restoreSnapshot = captureSnapshot(...networks)

  beforeEach(async () => {
    await restoreSnapshot()
    await Promise.all(
      networks.map(async (network) => {
        const blockNumber = (await network.api.rpc.chain.getHeader()).number.toNumber()

        network.dev.setHead(blockNumber)
      }),
    )
  })

  afterAll(async () => {
    await Promise.all(networks.map((network) => network.teardown()))
  })

  const [assetHubPolkadotClient, polkadotClient] = networks
  const number = (await polkadotClient.api.rpc.chain.getHeader()).number.toNumber()

  // 1. First, accelerate the end of the cool-off period
  polkadotClient.dev.setStorage({
    RcMigrator: {
      RcMigrationStage: { CoolOff: { end_at: number + 1 } },
    },
  })

  // 2. Next, create a new block to end it
  await polkadotClient.dev.newBlock()

  const stage = await polkadotClient.api.query.rcMigrator.rcMigrationStage()
  expect(stage.toJSON()).toBe({ SignalMigrationFinish: null })

  // 3. Create a new block in AH to intake data and finish migrating there
  await assetHubPolkadotClient.dev.newBlock()

  // 4. Create a new block in RC to move to `MigrationDone`
  await polkadotClient.dev.newBlock()

  return [assetHubPolkadotClient]
}
