import { assetHubPolkadot, bridgeHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, setupNetworks, type TestConfig } from '@e2e-test/shared'
import {
  authorizeUpgradeViaCollectives,
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite,
} from '@e2e-test/shared/upgrade.js'

import { describe, test } from 'vitest'

describe('asset hub & bridgeHub & collectives', async () => {
  const [assetHubPolkadotClient, bridgeHubClient, collectivesClient] = await setupNetworks(
    assetHubPolkadot,
    bridgeHubPolkadot,
    collectivesPolkadot,
  )

  test('Asset Hub authorizes Bridge Hub upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(assetHubPolkadotClient, bridgeHubClient, collectivesClient)
  })
})

const testConfig: TestConfig = {
  testSuiteName: 'asset hub & bridgeHub & collectives',
}

registerTestTree(
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite(
    assetHubPolkadot,
    bridgeHubPolkadot,
    collectivesPolkadot,
    testConfig,
  ),
)
