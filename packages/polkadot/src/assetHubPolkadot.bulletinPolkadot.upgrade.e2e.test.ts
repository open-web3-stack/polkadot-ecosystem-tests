import { assetHubPolkadot, bulletinPolkadot } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubPolkadot & bulletinPolkadot',
}

registerTestTree(
  governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubPolkadot, bulletinPolkadot, testConfig),
)
