import { peoplePolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(peoplePolkadot, {
    testSuiteName: 'Polkadot People Chain Accounts',
    addressEncoding: 0,
  }),
)
