import { assetHubNextWestend } from '@e2e-test/networks/chains'

import { stakingE2ETests } from '@e2e-test/shared'

stakingE2ETests(assetHubNextWestend, { testSuiteName: 'AHN Staking', addressEncoding: 0 })
