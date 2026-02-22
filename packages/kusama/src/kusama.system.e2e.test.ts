import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama System',
}

// TODO: Uncomment after Kusama 2.0+ release due to polkadot-fellows/runtimes#957
// registerTestTree(systemE2ETests(kusama, testConfig))

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubKusama, kusama, testConfig))
