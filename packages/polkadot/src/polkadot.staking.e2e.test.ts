import { polkadot } from '@e2e-test/networks/chains'
import { fullStakingTests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Staking',
  addressEncoding: 0,
  relayOrPara: 'Relay',
}

registerTestTree(fullStakingTests(polkadot, testConfig))
