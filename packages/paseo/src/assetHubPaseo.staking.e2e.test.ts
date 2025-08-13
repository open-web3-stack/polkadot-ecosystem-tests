import { assetHubPaseo } from '@e2e-test/networks/chains'
import { stakingE2ETests } from '@e2e-test/shared'

stakingE2ETests(assetHubPaseo, { testSuiteName: 'Paseo Asset Hub Staking', addressEncoding: 0 })
