import { assetHubWestend } from '@e2e-test/networks/chains'

import { schedulerE2ETests } from '@e2e-test/shared'

schedulerE2ETests(assetHubWestend, { testSuiteName: 'Westend Asset Hub Scheduler', addressEncoding: 42 })
