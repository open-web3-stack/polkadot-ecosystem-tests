import { collectivesPolkadot } from '@e2e-test/networks/chains'
import { accountsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  accountsE2ETests(collectivesPolkadot, {
    testSuiteName: 'Polkadot Collectives Accounts',
    addressEncoding: 0,
    blockProvider: 'Local',
    chainEd: 'Normal',
  }),
)
