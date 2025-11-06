import { assetHubPolkadot, coretimePolkadot } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, systemE2ETestsViaRemoteScheduler } from '@e2e-test/shared'

/* const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Coretime System',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(polkadot, coretimePolkadot, testConfig)) */

const testConfigForAssetHub: ParaTestConfig = {
  testSuiteName: 'Polkadot Coretime System',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubPolkadot, coretimePolkadot, testConfigForAssetHub))
