import { kusama } from '@e2e-test/networks/chains'
import { registerTestTree } from '@e2e-test/shared'
import { parasRegistrarE2ETest } from '@e2e-test/shared/paras-registrar'

registerTestTree(
  parasRegistrarE2ETest(kusama, {
    testSuiteName: 'Kusama Paras Registrar',
  }),
)
