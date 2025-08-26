import { assetHubKusama } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(assetHubKusama, {
    testSuiteName: 'Kusama Asset Hub Accounts',
    addressEncoding: 2,
  }),
)
