import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { assetHubVestingE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Asset Hub Vesting',
  addressEncoding: 0,
  relayOrPara: 'Relay',
}

registerTestTree(assetHubVestingE2ETests(assetHubPolkadot, testConfig))
