import { kusama } from '@e2e-test/networks/chains'

import { nominationPoolsE2ETests } from '@e2e-test/shared'

nominationPoolsE2ETests(kusama, { testSuiteName: 'Kusama Nomination Pools', addressEncoding: 2 })
