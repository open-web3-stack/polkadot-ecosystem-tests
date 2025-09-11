import { assetHubKusama } from '@e2e-test/networks/chains'
import { fullStakingTests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const pAssetHubTestConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Staking',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(fullStakingTests(assetHubKusama, pAssetHubTestConfig))
