import { polkadot } from '@e2e-test/networks/chains'
import {
  commonFilteredTests,
  commonUnfilteredTests,
  postAhmFilteringE2ETests,
  preimageNotFilteredTest,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const polkadotTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Post-AHM Filtering Tests',
}

const filteredTests = commonFilteredTests
const unfilteredTests = [...commonUnfilteredTests, preimageNotFilteredTest]

registerTestTree(postAhmFilteringE2ETests(polkadot, polkadotTestConfig, filteredTests, unfilteredTests))
