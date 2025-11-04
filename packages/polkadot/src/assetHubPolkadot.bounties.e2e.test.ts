import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseBountiesE2ETests, type ParaTestConfig, registerTestTree, setupNetworksForAssetHub } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Bounties',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  setupNetworks: setupNetworksForAssetHub,
}

registerTestTree(baseBountiesE2ETests(assetHubPolkadot, testConfig))
