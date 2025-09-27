import { kusama, peopleKusama } from '@e2e-test/networks/chains'
import { accountsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  accountsE2ETests(
    peopleKusama,
    {
      testSuiteName: 'Kusama People Chain Accounts',
      addressEncoding: 2,
      blockProvider: 'Local',
      chainEd: 'LowEd',
    },
    kusama,
  ),
)
