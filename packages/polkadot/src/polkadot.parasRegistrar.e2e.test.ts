import { polkadot } from '@e2e-test/networks/chains'
import { registerTestTree } from '@e2e-test/shared'
import { parasRegistrarE2ETest } from '@e2e-test/shared/paras-registrar'

registerTestTree(
  parasRegistrarE2ETest(polkadot, {
    testSuiteName: 'Polkadot Paras Registrar',
  }),
)
