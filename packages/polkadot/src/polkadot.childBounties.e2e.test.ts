import { polkadot } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Child Bounties',
  addressEncoding: 0,
  blockProvider: 'Local',
  asyncBacking: 'Enabled',
}

registerTestTree(baseChildBountiesE2ETests(polkadot, testConfig))
