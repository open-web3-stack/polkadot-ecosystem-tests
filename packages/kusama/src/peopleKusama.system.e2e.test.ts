import { assetHubKusama, kusama, peopleKusama } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama People System',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, peopleKusama, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubKusama, peopleKusama, testConfig))
