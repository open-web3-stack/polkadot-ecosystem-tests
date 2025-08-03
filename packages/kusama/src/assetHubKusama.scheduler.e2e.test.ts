import { kusama } from '@e2e-test/networks/chains'
import { schedulerE2ETests } from '@e2e-test/shared'

schedulerE2ETests(kusama, { testSuiteName: 'Asset Hub Kusama Scheduler E2E tests', addressEncoding: 2 })
