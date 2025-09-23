import { coretimeKusama, kusama } from '@e2e-test/networks/chains'
import { accountsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  accountsE2ETests(
    coretimeKusama,
    {
      testSuiteName: 'Kusama Coretime Accounts',
      addressEncoding: 2,
      blockProvider: 'Local',
      chainEd: 'LowEd',
    },
    kusama,
  ),
)
