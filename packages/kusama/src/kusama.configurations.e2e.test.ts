import { kusama } from '@e2e-test/networks/chains'
import { registerTestTree } from '@e2e-test/shared'
import { configurationsE2ETests } from '@e2e-test/shared/configurations'

registerTestTree(
  configurationsE2ETests(kusama, {
    testSuiteName: 'Kusama Configurations',
  }),
)
