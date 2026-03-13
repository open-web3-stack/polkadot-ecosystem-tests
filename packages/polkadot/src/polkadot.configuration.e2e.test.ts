import { polkadot } from '@e2e-test/networks/chains'
import { registerTestTree } from '@e2e-test/shared'
import { configurationE2ETests } from '@e2e-test/shared/configuration'

registerTestTree(
  configurationE2ETests(polkadot, {
    testSuiteName: 'Polkadot Configuration',
  }),
)
