import { assetHubPaseo } from '@e2e-test/networks/chains'
import { schedulerE2ETests } from '@e2e-test/shared'

schedulerE2ETests(assetHubPaseo, { testSuiteName: 'Paseo Asset Hub Scheduler', addressEncoding: 0 })
