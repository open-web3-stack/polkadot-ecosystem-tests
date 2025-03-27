import { assetHubNextWestend } from '@e2e-test/networks/chains'

import { nominationPoolsE2ETests } from '@e2e-test/shared'

nominationPoolsE2ETests(assetHubNextWestend, { testSuiteName: 'AHN Nomination Pools', addressEncoding: 0 })
