import { assetHubNextWestend } from '@e2e-test/networks/chains'

import { schedulerE2ETests } from '@e2e-test/shared'

schedulerE2ETests(assetHubNextWestend, { testSuiteName: 'AHN Scheduler', addressEncoding: 0 })
