import { type Chain, captureSnapshot, createNetworks } from '@e2e-test/networks'

import { afterAll, beforeEach } from 'vitest'

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
