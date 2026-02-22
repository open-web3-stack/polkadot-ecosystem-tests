import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETests, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama System',
}

registerTestTree(systemE2ETests(kusama, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubKusama, kusama, testConfig))
