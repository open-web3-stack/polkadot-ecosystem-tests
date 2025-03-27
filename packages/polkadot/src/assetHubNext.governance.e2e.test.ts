import { assetHubNextWestend } from '@e2e-test/networks/chains'

import { governanceE2ETests } from '@e2e-test/shared'

governanceE2ETests(assetHubNextWestend, { testSuiteName: 'AHN Governance', addressEncoding: 0 })
