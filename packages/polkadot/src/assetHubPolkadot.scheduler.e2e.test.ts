import { polkadot } from '@e2e-test/networks/chains'

import { schedulerE2ETests } from '@e2e-test/shared'

schedulerE2ETests(polkadot, { testSuiteName: 'Asset Hub Polkadot Scheduler E2E tests', addressEncoding: 0 })
