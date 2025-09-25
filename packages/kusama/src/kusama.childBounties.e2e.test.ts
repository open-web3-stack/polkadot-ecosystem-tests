import { kusama } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(baseChildBountiesE2ETests(kusama, { testSuiteName: 'Kusama Child Bounties', addressEncoding: 2 }))
