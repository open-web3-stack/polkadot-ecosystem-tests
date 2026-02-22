import { assetHubKusama, encointerKusama, kusama } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Encointer System',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, encointerKusama, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubKusama, encointerKusama, testConfig))
