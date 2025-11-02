import { kusama } from '@e2e-test/networks/chains'
import { postAhmFilteringE2ETests, type RelayTestConfig, registerTestTree } from '@e2e-test/shared'

const kusamaTestConfig: RelayTestConfig = {
  testSuiteName: 'Kusama Post-AHM Filtering Tests',
  addressEncoding: 2,
  blockProvider: 'Local',
}

registerTestTree(postAhmFilteringE2ETests(kusama, kusamaTestConfig))
