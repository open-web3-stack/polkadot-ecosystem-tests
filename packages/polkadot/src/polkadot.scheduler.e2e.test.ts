import { polkadot } from '@e2e-test/networks/chains'
import { baseSchedulerE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(baseSchedulerE2ETests(polkadot, { testSuiteName: 'Polkadot Scheduler' }))
