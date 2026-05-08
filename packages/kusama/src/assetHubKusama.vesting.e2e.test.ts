import { assetHubKusama } from '@e2e-test/networks/chains'
import { fullVestingE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const kahTestConfig: TestConfig = {
  testSuiteName: 'Kusama Asset Hub Vesting',
}

registerTestTree(fullVestingE2ETests(assetHubKusama, kahTestConfig))
