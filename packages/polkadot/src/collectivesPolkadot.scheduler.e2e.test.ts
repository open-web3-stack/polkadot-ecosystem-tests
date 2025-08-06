import { collectivesPolkadot } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(
  baseSchedulerE2ETests(collectivesPolkadot, {
    testSuiteName: 'Collectives Polkadot Scheduler E2E tests',
  }),
)
