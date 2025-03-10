import { assetHubNext } from '@e2e-test/networks/chains'

import { nominationPoolsE2ETests } from '@e2e-test/shared'

nominationPoolsE2ETests(assetHubNext, { testSuiteName: 'AHN Nomination Pools', addressEncoding: 0 })
