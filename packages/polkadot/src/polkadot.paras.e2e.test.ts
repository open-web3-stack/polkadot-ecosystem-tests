import { polkadot } from '@e2e-test/networks/chains'
import { parasE2ETest, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  parasE2ETest(polkadot, {
    testSuiteName: 'Polkadot Paras',
  }),
)
