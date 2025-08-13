import { assetHubPaseo, paseo } from '@e2e-test/networks/chains'
import { vestingE2ETests } from '@e2e-test/shared'

vestingE2ETests(paseo, assetHubPaseo, { testSuiteName: 'Paseo Asset Hub Vesting', addressEncoding: 0 })
