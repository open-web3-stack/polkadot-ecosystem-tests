import { assetHubPaseo } from '@e2e-test/networks/chains'
import { governanceE2ETests } from '@e2e-test/shared'

governanceE2ETests(assetHubPaseo, { testSuiteName: 'Paseo Asset Hub Governance', addressEncoding: 0 })
