import { polkadot } from '@e2e-test/networks/chains'
import { registerTestTree, relayVestingE2ETests, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Vesting',
  addressEncoding: 0,
  relayOrPara: 'Relay',
}

registerTestTree(relayVestingE2ETests(polkadot, testConfig))
