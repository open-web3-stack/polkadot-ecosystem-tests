import { kusama } from '@e2e-test/networks/chains'
import {
  commonFilteredTests,
  commonUnfilteredTests,
  postAhmFilteringE2ETests,
  registerTestTree,
  type TestConfig,
} from '@e2e-test/shared'

const kusamaTestConfig: TestConfig = {
  testSuiteName: 'Kusama Post-AHM Filtering Tests',
}

registerTestTree(postAhmFilteringE2ETests(kusama, kusamaTestConfig, commonFilteredTests, commonUnfilteredTests))
