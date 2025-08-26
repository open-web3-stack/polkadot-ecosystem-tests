import { kusama } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(kusama, {
    testSuiteName: 'Kusama Accounts',
    addressEncoding: 2,
  }),
)
