import { kusama, peopleKusama } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(
    peopleKusama,
    {
      testSuiteName: 'Kusama People Chain Accounts',
      addressEncoding: 2,
      chainEd: 'LowEd',
    },
    kusama,
  ),
)
