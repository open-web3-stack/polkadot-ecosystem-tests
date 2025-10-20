import { polkadot } from '@e2e-test/networks/chains'
import { fullVestingE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Vesting',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(fullVestingE2ETests(polkadot, testConfig))
