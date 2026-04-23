import { assetHubPolkadotLocal } from '@e2e-test/networks/chains'
import { baseMultiAssetBountiesE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Multi-Asset Bounties (Local)',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Disabled',
}

registerTestTree(baseMultiAssetBountiesE2ETests(assetHubPolkadotLocal, testConfig))
