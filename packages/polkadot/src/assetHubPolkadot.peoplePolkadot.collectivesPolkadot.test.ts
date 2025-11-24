import { assetHubPolkadot, collectivesPolkadot, peoplePolkadot } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, setupNetworks } from '@e2e-test/shared'
import {
  authorizeUpgradeViaCollectives,
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite,
} from '@e2e-test/shared/upgrade.js'

import { describe, test } from 'vitest'

describe('asset hub & people & collectives', async () => {
  const [assetHubPolkadotClient, peopleClient, collectivesClient] = await setupNetworks(
    assetHubPolkadot,
    peoplePolkadot,
    collectivesPolkadot,
  )

  test('Asset Hub authorizes People upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(assetHubPolkadotClient, peopleClient, collectivesClient)
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
    peoplePolkadot,
    collectivesPolkadot,
    testConfigForLocalScheduler,
  ),
)
