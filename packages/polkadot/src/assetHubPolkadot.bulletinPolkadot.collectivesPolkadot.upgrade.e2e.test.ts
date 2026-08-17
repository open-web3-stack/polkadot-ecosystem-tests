import { assetHubPolkadot, bulletinPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, setupNetworks, type TestConfig } from '@e2e-test/shared'
import {
  authorizeUpgradeViaCollectives,
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite,
} from '@e2e-test/shared/upgrade.js'

import { describe, test } from 'vitest'

describe('asset hub & bulletin & collectives', async () => {
  const [assetHubPolkadotClient, bulletinClient, collectivesClient] = await setupNetworks(
    assetHubPolkadot,
    bulletinPolkadot,
    collectivesPolkadot,
  )

  test('Asset Hub authorizes Bulletin upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(assetHubPolkadotClient, bulletinClient, collectivesClient)
  })
})

const testConfig: TestConfig = {
  testSuiteName: 'asset hub & bulletin & collectives',
}

registerTestTree(
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite(
    assetHubPolkadot,
    bulletinPolkadot,
    collectivesPolkadot,
    testConfig,
  ),
)
