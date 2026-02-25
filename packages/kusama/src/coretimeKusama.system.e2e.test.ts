import { assetHubKusama, coretimeKusama, kusama } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Coretime System',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, coretimeKusama, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubKusama, coretimeKusama, testConfig))
