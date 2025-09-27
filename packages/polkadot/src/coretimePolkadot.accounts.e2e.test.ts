import { coretimePolkadot, polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  accountsE2ETests(
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
