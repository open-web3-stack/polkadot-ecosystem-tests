import { assetHubPolkadot, collectivesPolkadot, coretimePolkadot } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, setupNetworks } from '@e2e-test/shared'
import {
  authorizeUpgradeViaCollectives,
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite,
} from '@e2e-test/shared/upgrade.js'

import { describe, test } from 'vitest'

describe('asset hub & coretime & collectives', async () => {
  const [assetHubPolkadotClient, coretimeClient, collectivesClient] = await setupNetworks(
    assetHubPolkadot,
    coretimePolkadot,
    collectivesPolkadot,
  )

  test('Asset Hub authorizes Coretime upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(assetHubPolkadotClient, coretimeClient, collectivesClient)
  })
})

const testConfigForLocalScheduler: ParaTestConfig = {
  testSuiteName: 'asset hub & coretime & collectives',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite(
    assetHubPolkadot,
    coretimePolkadot,
    collectivesPolkadot,
    testConfigForLocalScheduler,
  ),
)
