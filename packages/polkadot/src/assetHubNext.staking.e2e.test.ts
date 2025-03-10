import { assetHubNext } from '@e2e-test/networks/chains'

import { stakingE2ETests } from '@e2e-test/shared'

stakingE2ETests(assetHubNext, { testSuiteName: 'AHN Staking', addressEncoding: 0 })
