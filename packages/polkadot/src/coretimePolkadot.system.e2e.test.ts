import { assetHubPolkadot, coretimePolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsViaRemoteScheduler, type TestConfig } from '@e2e-test/shared'

const testConfigForAssetHub: TestConfig = {
  testSuiteName: 'Polkadot Coretime System',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubPolkadot, coretimePolkadot, testConfigForAssetHub))
