import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { basePreimageE2ETests, registerTestTree, setupNetworksForAssetHub, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub PreImage',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  setupNetworks: setupNetworksForAssetHub,
}

registerTestTree(basePreimageE2ETests(assetHubPolkadot, testConfig))
