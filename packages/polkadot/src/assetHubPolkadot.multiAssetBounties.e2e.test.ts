import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseMultiAssetBountiesE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Multi-Asset Bounties',
}

registerTestTree(baseMultiAssetBountiesE2ETests(assetHubPolkadot, testConfig))
