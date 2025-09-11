import { assetHubPaseo } from '@e2e-test/networks/chains'
import { fullStakingTests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const pAssetHubTestConfig: TestConfig = {
  testSuiteName: 'Paseo Asset Hub Staking',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(fullStakingTests(assetHubPaseo, pAssetHubTestConfig))
