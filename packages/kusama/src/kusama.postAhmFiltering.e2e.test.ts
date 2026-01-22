import { kusama } from '@e2e-test/networks/chains'
import {
  commonFilteredTests,
  commonUnfilteredTests,
  postAhmFilteringE2ETests,
  preimageNotFilteredTest,
  type RelayTestConfig,
  registerTestTree,
} from '@e2e-test/shared'

const kusamaTestConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Post-AHM Filtering Tests',
  addressEncoding: 2,
  blockProvider: 'Local',
}

// Kusama: preimage calls are NOT filtered post-AHM (different from Polkadot)
const filteredTests = commonFilteredTests
const unfilteredTests = [...commonUnfilteredTests, preimageNotFilteredTest]

registerTestTree(postAhmFilteringE2ETests(kusama, kusamaTestConfig, filteredTests, unfilteredTests))
