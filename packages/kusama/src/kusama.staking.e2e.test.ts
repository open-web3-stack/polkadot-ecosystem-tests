import { kusama } from '@e2e-test/networks/chains'

import { fullStakingTests, registerTestTree } from '@e2e-test/shared'

registerTestTree(fullStakingTests(kusama, { testSuiteName: 'Kusama Staking', addressEncoding: 2 }))
