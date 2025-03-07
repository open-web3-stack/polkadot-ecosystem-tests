import { collectivesPolkadot } from '@e2e-test/networks/chains'

import { schedulerE2ETests } from '@e2e-test/shared'

schedulerE2ETests(collectivesPolkadot, {
  testSuiteName: 'Collectives Polkadot Scheduler E2E tests',
  addressEncoding: 0,
})
