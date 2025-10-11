import { polkadot } from '@e2e-test/networks/chains'
import { baseBountiesE2ETests, registerTestTree, type TestConfig } from '@e2e-test/shared'

const testConfig: TestConfig = {
  testSuiteName: 'Polkadot Bounties',
  addressEncoding: 0,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(baseBountiesE2ETests(polkadot, testConfig))
