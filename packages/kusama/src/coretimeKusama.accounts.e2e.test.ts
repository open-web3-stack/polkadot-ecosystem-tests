import { coretimeKusama, kusama } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(
    coretimeKusama,
    {
      testSuiteName: 'Kusama Coretime Accounts',
      addressEncoding: 2,
      chainEd: 'LowEd',
    },
    kusama,
  ),
)
