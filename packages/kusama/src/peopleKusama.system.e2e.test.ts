import { assetHubKusama, peopleKusama } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

// TODO: Uncomment after Kusama 2.0+ release due to polkadot-fellows/runtimes#957
// registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, peopleKusama, testConfig))

const testConfig: TestConfig = {
  testSuiteName: 'Kusama People System',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubKusama, peopleKusama, testConfig))
