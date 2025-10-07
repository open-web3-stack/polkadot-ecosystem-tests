import { kusama } from '@e2e-test/networks/chains'
import { baseBountiesE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(baseBountiesE2ETests(kusama, { testSuiteName: 'Kusama Bounties', addressEncoding: 2 }))
