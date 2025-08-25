import { polkadot } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(transferFunctionsTests(polkadot, { testSuiteName: 'Polkadot Accounts', addressEncoding: 0 }))
