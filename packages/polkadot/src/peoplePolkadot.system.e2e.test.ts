import { assetHubPolkadot, peoplePolkadot } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, systemE2ETestsViaRemoteScheduler } from '@e2e-test/shared'

/* const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot People System',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(polkadot, peoplePolkadot, testConfig))
*/

const testConfigForAssetHub: ParaTestConfig = {
  testSuiteName: 'Polkadot People System',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubPolkadot, peoplePolkadot, testConfigForAssetHub))
