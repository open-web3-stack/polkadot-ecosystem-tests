import { kusama } from '@e2e-test/networks/chains'
import { stakingE2ETests } from '@e2e-test/shared'

stakingE2ETests(kusama, { testSuiteName: 'Kusama Staking', addressEncoding: 2 })
