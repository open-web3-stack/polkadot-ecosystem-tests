import { assetHubKusama, bridgeHubKusama } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubKusama & bridgeHubKusama',
}

registerTestTree(governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubKusama, bridgeHubKusama, testConfig))
