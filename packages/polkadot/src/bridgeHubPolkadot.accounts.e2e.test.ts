import { bridgeHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  accountsE2ETests(
    bridgeHubPolkadot,
    {
      testSuiteName: 'Polkadot Bridge Hub Accounts',
      blockProvider: 'Local',
      addressEncoding: 0,
      chainEd: 'LowEd',
    },
    polkadot,
  ),
)
