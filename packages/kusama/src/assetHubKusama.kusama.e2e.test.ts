import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import {
  governanceChainSelfUpgradeViaWhitelistedCallerReferendumSuite,
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubKusama & kusama',
}

registerTestTree(governanceChainSelfUpgradeViaWhitelistedCallerReferendumSuite(assetHubKusama, kusama, testConfig))

registerTestTree(governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubKusama, kusama, testConfig))
