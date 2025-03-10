import { assetHubNext } from '@e2e-test/networks/chains'

import { schedulerE2ETests } from '@e2e-test/shared'

schedulerE2ETests(assetHubNext, { testSuiteName: 'AHN Scheduler', addressEncoding: 0 })
