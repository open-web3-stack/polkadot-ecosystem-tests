import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, systemE2ETestsForParaWithScheduler, type TestConfig } from '@e2e-test/shared'

const testConfigForLocalScheduler: TestConfig = {
  testSuiteName: 'Polkadot AssetHub System',
}

registerTestTree(systemE2ETestsForParaWithScheduler(assetHubPolkadot, testConfigForLocalScheduler))
