import { assetHubPolkadot, bridgeHubPolkadot } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, systemE2ETestsViaRemoteScheduler } from '@e2e-test/shared'

/* const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot BridgeHub System',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(polkadot, bridgeHubPolkadot, testConfig))
*/

const testConfigForAssetHub: ParaTestConfig = {
  testSuiteName: 'Polkadot BridgeHub System',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubPolkadot, bridgeHubPolkadot, testConfigForAssetHub))
