import { kusama } from '@e2e-test/networks/chains'
import { baseNominationPoolsE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Kusama Nomination Pools',
  addressEncoding: 2,
  relayOrPara: 'Relay',
}

registerTestTree(baseNominationPoolsE2ETests(kusama, testConfig))
