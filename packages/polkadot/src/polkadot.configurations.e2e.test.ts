import { polkadot } from '@e2e-test/networks/chains'
import { registerTestTree } from '@e2e-test/shared'
import { configurationsE2ETests } from '@e2e-test/shared/configurations'

registerTestTree(
  configurationsE2ETests(polkadot, {
    testSuiteName: 'Polkadot Configurations',
  }),
)
