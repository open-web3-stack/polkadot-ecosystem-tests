import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { fullVestingE2ETests, type ParaTestConfig, registerTestTree, setupNetworksForAssetHub } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Vesting',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  setupNetworks: setupNetworksForAssetHub,
}

registerTestTree(fullVestingE2ETests(assetHubPolkadot, testConfig))
