import { assetHubPolkadot, bridgeHubPolkadot } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubPolkadot & bridgeHubPolkadot',
}

registerTestTree(
  governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubPolkadot, bridgeHubPolkadot, testConfig),
)
