import { kusama } from '@e2e-test/networks/chains'

import { baseGovernanceE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(baseGovernanceE2ETests(kusama, { testSuiteName: 'Kusama Governance', addressEncoding: 2 }))
