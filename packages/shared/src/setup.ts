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

export const setupNetworksForAssetHub: typeof setupNetworks = (async <T extends Chain[]>(...chains: T) => {
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
  const relayBlockNumber = (await polkadotClient.api.rpc.chain.getHeader()).number.toNumber()

  // 1. Accelerate the end of the cool-off period
  polkadotClient.dev.setStorage({
    RcMigrator: {
      RcMigrationStage: { CoolOff: { end_at: relayBlockNumber + 1 } },
    },
  })
  assetHubPolkadotClient.dev.setStorage({
    AhMigrator: {
      AhMigrationStage: { CoolOff: { end_at: relayBlockNumber - 10 } },
    },
  })

  // 2. Create a new block to end it
  await polkadotClient.dev.newBlock()
  await assetHubPolkadotClient.dev.newBlock()
  await polkadotClient.dev.newBlock()
  await assetHubPolkadotClient.dev.newBlock()

  const relayStage = await polkadotClient.api.query.rcMigrator.rcMigrationStage()
  expect(relayStage.toHuman()).toBe('MigrationDone')
  const assetHubStage = await assetHubPolkadotClient.api.query.ahMigrator.ahMigrationStage()
  expect(assetHubStage.toHuman()).toBe('MigrationDone')

  return [assetHubPolkadotClient]
}) as unknown as typeof setupNetworks

/**
 * Ad-hoc function to setup Polkadot relay for AHM E2E tests.
 *
 * Does the same as the usual `setupNetworks` function, but artificially advances to the end of the cool-off period.
 */
export async function setupNetworksForRelay<T extends Chain[]>(...chains: T) {
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

  const [polkadotClient] = networks
  const currentRelayBlockNum = (await polkadotClient.api.rpc.chain.getHeader()).number.toNumber()

  // 1. Accelerate the end of the cool-off period
  polkadotClient.dev.setStorage({
    RcMigrator: {
      RcMigrationStage: { CoolOff: { end_at: currentRelayBlockNum + 1 } },
    },
  })

  // 2. Create a new block to end it
  await polkadotClient.dev.newBlock()

  const relayStage = await polkadotClient.api.query.rcMigrator.rcMigrationStage()
  expect(relayStage.toHuman()).toBe('MigrationDone')

  return networks
}
