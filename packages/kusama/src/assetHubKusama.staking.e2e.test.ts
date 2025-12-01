import { assetHubKusama } from '@e2e-test/networks/chains'
import { fullStakingE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const pAssetHubTestConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Asset Hub Staking',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(fullStakingE2ETests(assetHubKusama, pAssetHubTestConfig))
