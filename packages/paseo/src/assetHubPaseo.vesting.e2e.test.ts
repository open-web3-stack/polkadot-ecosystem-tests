import { assetHubPaseo } from '@e2e-test/networks/chains'
import { assetHubVestingE2ETests, type ParaTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ParaTestConfig = {
  testSuiteName: 'Paseo Asset Hub Vesting',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(assetHubVestingE2ETests(assetHubPaseo, testConfig))
