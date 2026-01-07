import { assetHubPolkadot, collectivesPolkadot, polkadot } from '@e2e-test/networks/chains'
import {
  authorizeUpgradeViaCollectives,
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite,
  type ParaTestConfig,
  registerTestTree,
  setupNetworks,
} from '@e2e-test/shared'

import { describe, test } from 'vitest'

describe('asset hub & polkadot & collectives', async () => {
  const [assetHubPolkadotClient, polkadotClient, collectivesClient] = await setupNetworks(
    assetHubPolkadot,
    polkadot,
    collectivesPolkadot,
  )

  test('Asset Hub authorizes Polkadot upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(assetHubPolkadotClient, polkadotClient, collectivesClient)
  })
})

const testConfigForLocalScheduler: ParaTestConfig = {
  testSuiteName: 'asset hub & people & collectives',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite(
    assetHubPolkadot,
    polkadot,
    collectivesPolkadot,
    testConfigForLocalScheduler,
  ),
)
