import { assetHubPolkadot, peoplePolkadot } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubPolkadot & peoplePolkadot',
}

registerTestTree(governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubPolkadot, peoplePolkadot, testConfig))
