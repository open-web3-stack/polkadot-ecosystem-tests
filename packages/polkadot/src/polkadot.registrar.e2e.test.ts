import { polkadot } from '@e2e-test/networks/chains'
import { registerTestTree, registrarE2ETest } from '@e2e-test/shared'

registerTestTree(
  registrarE2ETest(polkadot, {
    testSuiteName: 'Polkadot Registrar',
  }),
)
