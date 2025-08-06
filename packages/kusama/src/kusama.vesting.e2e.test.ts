import { kusama } from '@e2e-test/networks/chains'
import { registerTestTree, relayVestingE2ETests } from '@e2e-test/shared'

registerTestTree(relayVestingE2ETests(kusama, { testSuiteName: 'Kusama Vesting', addressEncoding: 2 }))
