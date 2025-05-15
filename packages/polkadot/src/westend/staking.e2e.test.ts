import { assetHubWestend } from '@e2e-test/networks/chains'

import { stakingE2ETests } from '@e2e-test/shared'

stakingE2ETests(assetHubWestend, { testSuiteName: 'Westend Asset Hub Staking', addressEncoding: 0 })
