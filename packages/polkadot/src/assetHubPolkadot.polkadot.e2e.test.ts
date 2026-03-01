import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubPolkadot & polkadot',
}

registerTestTree(governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubPolkadot, polkadot, testConfig))
