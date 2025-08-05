import { kusama } from '@e2e-test/networks/chains'

import { baseNominationPoolsE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(baseNominationPoolsE2ETests(kusama, { testSuiteName: 'Kusama Nomination Pools', addressEncoding: 2 }))
