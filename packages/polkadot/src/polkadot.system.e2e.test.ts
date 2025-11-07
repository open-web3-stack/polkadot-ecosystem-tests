import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { type ParaTestConfig, registerTestTree, systemE2ETestsViaRemoteScheduler } from '@e2e-test/shared'

const testConfigForAssetHub: ParaTestConfig = {
  testSuiteName: 'Polkadot System',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(systemE2ETestsViaRemoteScheduler(assetHubPolkadot, polkadot, testConfigForAssetHub))
