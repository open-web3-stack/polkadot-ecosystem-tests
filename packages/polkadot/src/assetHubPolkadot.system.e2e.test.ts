import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, systemE2ETestsForParaWithScheduler } from '@e2e-test/shared'

/* const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot AssetHub System',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETests(assetHubPolkadot, testConfig))
 */

const testConfigForLocalScheduler: ParaTestConfig = {
  testSuiteName: 'Polkadot AssetHub System',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsForParaWithScheduler(assetHubPolkadot, testConfigForLocalScheduler))
