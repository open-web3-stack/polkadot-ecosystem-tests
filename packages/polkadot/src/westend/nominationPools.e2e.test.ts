import { assetHubWestend } from '@e2e-test/networks/chains'

import { nominationPoolsE2ETests } from '@e2e-test/shared'

nominationPoolsE2ETests(assetHubWestend, { testSuiteName: 'Westend Asset Hub Nomination Pools', addressEncoding: 0 })
