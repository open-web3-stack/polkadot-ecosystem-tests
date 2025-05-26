import { assetHubWestend } from '@e2e-test/networks/chains'

import { vestingE2ETests } from '@e2e-test/shared'

vestingE2ETests(assetHubWestend, { testSuiteName: 'Westend Asset Hub Vesting', addressEncoding: 42 })
