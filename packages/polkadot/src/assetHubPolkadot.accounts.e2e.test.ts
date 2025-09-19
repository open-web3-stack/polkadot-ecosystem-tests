import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(
    assetHubPolkadot,
    {
      testSuiteName: 'Polkadot Asset Hub Accounts',
      addressEncoding: 0,
      blockProvider: 'NonLocal',
      asyncBacking: 'Enabled',
      chainEd: 'Normal',
    },
    polkadot,
  ),
)
