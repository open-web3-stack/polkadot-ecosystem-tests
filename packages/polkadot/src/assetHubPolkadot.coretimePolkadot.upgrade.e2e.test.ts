import { assetHubPolkadot, coretimePolkadot } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubPolkadot & coretimePolkadot',
}

registerTestTree(
  governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubPolkadot, coretimePolkadot, testConfig),
)
