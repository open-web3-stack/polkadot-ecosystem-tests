import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import {
  governanceChainSelfUpgradeViaRootReferendumSuite,
  registerTestTree,
  systemE2ETestsForParaWithScheduler,
  systemE2ETestsViaRemoteScheduler,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama AssetHub System',
}

registerTestTree(governanceChainSelfUpgradeViaRootReferendumSuite(assetHubKusama, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, assetHubKusama, testConfig))

registerTestTree(systemE2ETestsForParaWithScheduler(assetHubKusama, testConfig))
