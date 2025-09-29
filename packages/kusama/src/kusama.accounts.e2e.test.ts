import { kusama } from '@e2e-test/networks/chains'
import { accountsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  accountsE2ETests(kusama, {
    testSuiteName: 'Kusama Accounts',
    addressEncoding: 2,
    blockProvider: 'Local',
    chainEd: 'LowEd',
  }),
)
