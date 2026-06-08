import { polkadot } from '@e2e-test/networks/chains'
import { configurationE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  configurationE2ETests(polkadot, {
    testSuiteName: 'Polkadot Configuration',
  }),
)
