import { kusama } from '@e2e-test/networks/chains'
import {
  commonFilteredTests,
  commonUnfilteredTests,
  postAhmFilteringE2ETests,
  preimageNotFilteredTest,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const kusamaTestConfig: TestConfig = {
  testSuiteName: 'Kusama Post-AHM Filtering Tests',
}

// Kusama: preimage calls are NOT filtered post-AHM (different from Polkadot)
const filteredTests = commonFilteredTests
const unfilteredTests = [...commonUnfilteredTests, preimageNotFilteredTest]

registerTestTree(postAhmFilteringE2ETests(kusama, kusamaTestConfig, filteredTests, unfilteredTests))
