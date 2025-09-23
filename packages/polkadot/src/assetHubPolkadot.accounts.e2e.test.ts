import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  accountsE2ETests(
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
