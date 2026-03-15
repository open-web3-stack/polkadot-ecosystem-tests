import { assetHubKusama, peopleKusama } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'assetHubKusama & peopleKusama',
}

registerTestTree(governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubKusama, peopleKusama, testConfig))
