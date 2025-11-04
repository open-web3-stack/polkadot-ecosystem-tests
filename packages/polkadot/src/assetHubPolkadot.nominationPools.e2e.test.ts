import { assetHubPolkadot } from '@e2e-test/networks/chains'
import {
  baseNominationPoolsE2ETests,
  registerTestTree,
  setupNetworksForAssetHub,
  type TestConfig,
} from '@e2e-test/shared'

const assetHubPolkadotTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Nomination Pools',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  setupNetworks: setupNetworksForAssetHub,
}

registerTestTree(baseNominationPoolsE2ETests(assetHubPolkadot, assetHubPolkadotTestConfig))
