import { kusama } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests } from '@e2e-test/shared/child_bounties'
import { registerTestTree } from '@e2e-test/shared/types'

registerTestTree(baseChildBountiesE2ETests(kusama, { testSuiteName: 'Kusama Child Bounties', addressEncoding: 2 }))
