import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import {
  governanceChainSelfUpgradeViaWhitelistedCallerReferendumSuite,
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubPolkadot & collectivesPolkadot',
}

registerTestTree(
  governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubPolkadot, collectivesPolkadot, testConfig),
)

registerTestTree(
  governanceChainUpgradesOtherChainViaWhitelistedCallerReferendumSuite(
    assetHubPolkadot,
    collectivesPolkadot,
    collectivesPolkadot,
    testConfig,
  ),
)

registerTestTree(
  governanceChainSelfUpgradeViaWhitelistedCallerReferendumSuite(assetHubPolkadot, collectivesPolkadot, testConfig),
)
