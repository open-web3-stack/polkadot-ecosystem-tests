import { bridgeHubKusama, kusama } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(
    bridgeHubKusama,
    {
      testSuiteName: 'Kusama Bridge Hub Accounts',
      addressEncoding: 2,
      blockProvider: 'Local',
      chainEd: 'LowEd',
    },
    kusama,
  ),
)
