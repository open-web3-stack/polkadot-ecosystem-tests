import { kusama } from '@e2e-test/networks/chains'

import { governanceE2ETests } from '@e2e-test/shared'

governanceE2ETests(kusama, { testSuiteName: "Kusama Governance", addressEncoding: 2})
