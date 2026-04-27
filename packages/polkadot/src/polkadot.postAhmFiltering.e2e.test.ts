import { polkadot } from '@e2e-test/networks/chains'
import {
  commonFilteredTests,
  commonUnfilteredTests,
  postAhmFilteringE2ETests,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const polkadotTestConfig: TestConfig = {
  testSuiteName: 'Polkadot Post-AHM Filtering Tests',
}

registerTestTree(postAhmFilteringE2ETests(polkadot, polkadotTestConfig, commonFilteredTests, commonUnfilteredTests))
