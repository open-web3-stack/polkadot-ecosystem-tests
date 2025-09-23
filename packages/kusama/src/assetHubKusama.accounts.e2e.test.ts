import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import { accountsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  accountsE2ETests(
    assetHubKusama,
    {
      testSuiteName: 'Kusama Asset Hub Accounts',
      addressEncoding: 2,
      blockProvider: 'NonLocal',
      asyncBacking: 'Enabled',
      chainEd: 'LowEd',
    },
    kusama,
  ),
)
