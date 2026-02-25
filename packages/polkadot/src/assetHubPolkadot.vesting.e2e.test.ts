import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { fullVestingE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Vesting',
}

registerTestTree(fullVestingE2ETests(assetHubPolkadot, testConfig))
