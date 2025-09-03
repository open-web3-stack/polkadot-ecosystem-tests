import { assetHubKusama } from '@e2e-test/networks/chains'
import { assetHubVestingE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const kahTestConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Vesting',
  addressEncoding: 2,
  relayOrPara: 'Relay',
}

registerTestTree(assetHubVestingE2ETests(assetHubKusama, kahTestConfig))
