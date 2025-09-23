import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  accountsE2ETests(
    peoplePolkadot,
    {
      testSuiteName: 'Polkadot People Chain Accounts',
      addressEncoding: 0,
      blockProvider: 'Local',
      chainEd: 'Normal',
    },
    polkadot,
  ),
)
