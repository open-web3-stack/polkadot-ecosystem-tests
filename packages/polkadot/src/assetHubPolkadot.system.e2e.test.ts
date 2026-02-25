import { assetHubPolkadot } from '@e2e-test/networks/chains'
import {
  governanceChainSelfUpgradeViaRootReferendumSuite,
  registerTestTree,
  systemE2ETestsForParaWithScheduler,
  type TestConfig,
} from '@e2e-test/shared'

const testConfigForLocalScheduler: TestConfig = {
  testSuiteName: 'Polkadot AssetHub System',
}

registerTestTree(systemE2ETestsForParaWithScheduler(assetHubPolkadot, testConfigForLocalScheduler))

registerTestTree(governanceChainSelfUpgradeViaRootReferendumSuite(assetHubPolkadot, testConfigForLocalScheduler))
