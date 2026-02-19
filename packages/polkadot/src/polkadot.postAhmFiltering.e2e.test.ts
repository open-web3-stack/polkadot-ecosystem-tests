import { polkadot } from '@e2e-test/networks/chains'
import {
  commonFilteredTests,
  commonUnfilteredTests,
  postAhmFilteringE2ETests,
  preimageFilteredTest,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const polkadotTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Post-AHM Filtering Tests',
}

// Polkadot: preimage calls ARE filtered post-AHM
const filteredTests = [...commonFilteredTests, preimageFilteredTest]
const unfilteredTests = commonUnfilteredTests

registerTestTree(postAhmFilteringE2ETests(polkadot, polkadotTestConfig, filteredTests, unfilteredTests))
