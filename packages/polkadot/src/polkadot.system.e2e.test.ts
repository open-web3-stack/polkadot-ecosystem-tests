import { polkadot } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, systemE2ETests } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot System',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(systemE2ETests(polkadot, testConfig))

// TODO: Uncomment Post-AHM on Polkadot

// const testConfigForAssetHub: ParaTestConfig = {
//   testSuiteName: 'Polkadot System',
//   addressEncoding: 0,
//   blockProvider: 'NonLocal',
//   asyncBacking: 'Enabled',
// }

// registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubPolkadot, polkadot, testConfigForAssetHub))
