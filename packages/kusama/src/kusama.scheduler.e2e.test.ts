import { kusama } from '@e2e-test/networks/chains'
import { schedulerE2ETests } from '@e2e-test/shared'

schedulerE2ETests(kusama, { testSuiteName: 'Kusama Scheduler', addressEncoding: 0 })
