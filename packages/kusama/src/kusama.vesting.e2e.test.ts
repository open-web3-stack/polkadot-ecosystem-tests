import { kusama } from '@e2e-test/networks/chains'

import { vestingE2ETests } from '@e2e-test/shared'

vestingE2ETests(kusama, { testSuiteName: 'Kusama Vesting', addressEncoding: 2 })
