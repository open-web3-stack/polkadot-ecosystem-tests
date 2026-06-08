import { kusama } from '@e2e-test/networks/chains'
import { configurationE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  configurationE2ETests(kusama, {
    testSuiteName: 'Kusama Configuration',
  }),
)
