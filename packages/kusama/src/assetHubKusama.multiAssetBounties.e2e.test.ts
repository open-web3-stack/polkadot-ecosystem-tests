import { assetHubKusama } from '@e2e-test/networks/chains'
import { baseMultiAssetBountiesE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Asset Hub Multi-Asset Bounties',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseMultiAssetBountiesE2ETests(assetHubKusama, testConfig))
