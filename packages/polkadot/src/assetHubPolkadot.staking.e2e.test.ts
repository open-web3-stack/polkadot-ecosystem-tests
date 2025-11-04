import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { fullStakingE2ETests, registerTestTree, setupNetworksForAssetHub, type TestConfig } from '@e2e-test/shared'

const assetHubPolkadotTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Staking',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  setupNetworks: setupNetworksForAssetHub,
}

registerTestTree(fullStakingE2ETests(assetHubPolkadot, assetHubPolkadotTestConfig))
