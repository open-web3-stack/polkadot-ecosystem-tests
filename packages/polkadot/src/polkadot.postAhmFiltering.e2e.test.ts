import { polkadot } from '@e2e-test/networks/chains'
import {
  commonFilteredTests,
  commonUnfilteredTests,
  postAhmFilteringE2ETests,
  preimageFilteredTest,
  type RelayTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const polkadotTestConfig: RelayTestConfig = {
  testSuiteName: 'Polkadot Post-AHM Filtering Tests',
  addressEncoding: 0,
  blockProvider: 'Local',
}

// Polkadot: preimage calls ARE filtered post-AHM
const filteredTests = [...commonFilteredTests, preimageFilteredTest]
const unfilteredTests = commonUnfilteredTests

registerTestTree(postAhmFilteringE2ETests(polkadot, polkadotTestConfig, filteredTests, unfilteredTests))
