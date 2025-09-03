import { polkadot } from '@e2e-test/networks/chains'
import { baseNominationPoolsE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Nomination Pools',
  addressEncoding: 0,
  relayOrPara: 'Relay',
}

registerTestTree(baseNominationPoolsE2ETests(polkadot, testConfig))
