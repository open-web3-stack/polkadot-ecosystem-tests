import { assetHubPolkadot } from '@e2e-test/networks/chains'
import {
  baseChildBountiesE2ETests,
  type ParaTestConfig,
  registerTestTree,
  setupNetworksForAssetHub,
} from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Child Bounties',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  setupNetworks: setupNetworksForAssetHub,
}

registerTestTree(baseChildBountiesE2ETests(assetHubPolkadot, testConfig))
