import { kusama } from '@e2e-test/networks/chains'
import { registerTestTree, relayVestingE2ETests, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Vesting',
  addressEncoding: 2,
  relayOrPara: 'Relay',
}

registerTestTree(relayVestingE2ETests(kusama, testConfig))
