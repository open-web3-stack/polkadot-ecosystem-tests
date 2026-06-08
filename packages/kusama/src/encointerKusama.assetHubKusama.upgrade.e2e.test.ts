import { assetHubKusama, encointerKusama } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'encointerKusama & assetHubKusama',
}

registerTestTree(governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubKusama, encointerKusama, testConfig))
