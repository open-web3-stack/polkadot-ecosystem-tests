import { kusama } from '@e2e-test/networks/chains'
import { registerTestTree } from '@e2e-test/shared'
import { registrarE2ETest } from '@e2e-test/shared/registrar'

registerTestTree(
  registrarE2ETest(kusama, {
    testSuiteName: 'Kusama Registrar',
  }),
)
