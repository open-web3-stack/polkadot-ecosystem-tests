import { assetHubKusama } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsForParaWithScheduler, type TestConfig } from '@e2e-test/shared'

// TODO: Uncomment after Kusama 2.0+ release due to polkadot-fellows/runtimes#957
// registerTestTree(systemE2ETestsViaRemoteScheduler(kusama, assetHubKusama, testConfig))

const testConfig: TestConfig = {
  testSuiteName: 'Kusama AssetHub System',
}

registerTestTree(systemE2ETestsForParaWithScheduler(assetHubKusama, testConfig))
