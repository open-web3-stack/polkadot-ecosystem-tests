import { polkadot } from '@e2e-test/networks/chains'
import { type RelayTestConfig, registerTestTree, relayVestingE2ETests } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Vesting',
  addressEncoding: 0,
  relayOrPara: 'Relay',
}

registerTestTree(relayVestingE2ETests(polkadot, testConfig))
