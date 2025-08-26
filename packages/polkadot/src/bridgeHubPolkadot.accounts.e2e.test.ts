import { bridgeHubPolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(bridgeHubPolkadot, {
    testSuiteName: 'Polkadot Bridge Hub Accounts',
    addressEncoding: 0,
  }),
)
