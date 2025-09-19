import { collectivesPolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, transferFunctionsTests } from '@e2e-test/shared'

registerTestTree(
  transferFunctionsTests(collectivesPolkadot, {
    testSuiteName: 'Polkadot Collectives Accounts',
    addressEncoding: 0,
    blockProvider: 'Local',
    chainEd: 'Normal',
  }),
)
