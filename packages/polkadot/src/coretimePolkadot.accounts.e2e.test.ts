import { coretimePolkadot, polkadot } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(
    coretimePolkadot,
    {
      testSuiteName: 'Polkadot Coretime Accounts',
      addressEncoding: 0,
      blockProvider: 'Local',
      asyncBacking: 'Enabled',
      chainEd: 'Normal',
    },
    polkadot,
  ),
)
