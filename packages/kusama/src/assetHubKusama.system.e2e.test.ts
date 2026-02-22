import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import {
  registerTestTree,
  systemE2ETestsForParaWithScheduler,
  systemE2ETestsViaRemoteScheduler,
  type TestConfig,
} from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama AssetHub System',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, assetHubKusama, testConfig))

registerTestTree(systemE2ETestsForParaWithScheduler(assetHubKusama, testConfig))
