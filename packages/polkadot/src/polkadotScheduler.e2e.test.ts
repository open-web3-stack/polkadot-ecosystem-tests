import { polkadot } from '@e2e-test/networks/chains'

import { schedulerE2ETests } from '@e2e-test/shared'

schedulerE2ETests(polkadot, { testSuiteName: 'Polkadot Scheduler', addressEncoding: 0 })
