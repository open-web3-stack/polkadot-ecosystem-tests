import { assetHubKusama } from '@e2e-test/networks/chains'
import { fullVestingE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const kahTestConfig: ParaTestConfig = {
  testSuiteName: 'Kusama Asset Hub Vesting',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(fullVestingE2ETests(assetHubKusama, kahTestConfig))
