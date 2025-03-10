import { assetHubNext } from '@e2e-test/networks/chains'

import { governanceE2ETests } from '@e2e-test/shared'

governanceE2ETests(assetHubNext, { testSuiteName: 'AHN Governance', addressEncoding: 0 })
