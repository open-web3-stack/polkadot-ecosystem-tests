import { polkadot } from '@e2e-test/networks/chains'
import { baseBountiesE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Bounties',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(baseBountiesE2ETests(polkadot, testConfig))
