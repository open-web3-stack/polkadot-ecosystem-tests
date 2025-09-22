import { polkadot } from '@e2e-test/networks/chains'
import { completeStakingE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Staking',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(completeStakingE2ETests(polkadot, testConfig))
