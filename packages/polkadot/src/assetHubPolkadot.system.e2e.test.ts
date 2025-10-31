import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, systemE2ETestsViaRemoteScheduler } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot AssetHub System',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(polkadot, assetHubPolkadot, testConfig))

// TODO: Uncomment Post-AHM on Polkadot

// const testConfigForLocalScheduler: ParaTestConfig = {
//   testSuiteName: 'Polkadot AssetHub System',
//   addressEncoding: 0,
//   blockProvider: 'NonLocal',
//   asyncBacking: 'Enabled',
// }

// registerTestTree(systemE2ETestsForParaWithScheduler(assetHubPolkadot, testConfigForLocalScheduler))
