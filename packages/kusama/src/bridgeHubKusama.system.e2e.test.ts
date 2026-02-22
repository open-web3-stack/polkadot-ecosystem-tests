import { assetHubKusama, bridgeHubKusama, kusama } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama BridgeHub System',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, bridgeHubKusama, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubKusama, bridgeHubKusama, testConfig))
