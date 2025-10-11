import { assetHubKusama } from '@e2e-test/networks/chains'
import { fullStakingE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const pAssetHubTestConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Staking',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(fullStakingE2ETests(assetHubKusama, pAssetHubTestConfig))
