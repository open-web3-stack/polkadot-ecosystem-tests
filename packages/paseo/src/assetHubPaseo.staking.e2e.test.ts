import { assetHubPaseo } from '@e2e-test/networks/chains'
import { fullStakingE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const pAssetHubTestConfig: TestConfig = {
  testSuiteName: 'Paseo Asset Hub Staking',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(fullStakingE2ETests(assetHubPaseo, pAssetHubTestConfig))
