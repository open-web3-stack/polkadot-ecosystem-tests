import { polkadot } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Child Bounties',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(baseChildBountiesE2ETests(polkadot, testConfig))
