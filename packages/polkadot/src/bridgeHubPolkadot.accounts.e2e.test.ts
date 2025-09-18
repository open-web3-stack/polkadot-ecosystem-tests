import { bridgeHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(
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
