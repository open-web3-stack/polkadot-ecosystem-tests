import { polkadot } from '@e2e-test/networks/chains'
import { postAhmFilteringE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const polkadotTestConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Post-AHM Filtering Tests',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(postAhmFilteringE2ETests(polkadot, polkadotTestConfig))
