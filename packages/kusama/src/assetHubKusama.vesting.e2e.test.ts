import { assetHubKusama } from '@e2e-test/networks/chains'
import { vestingE2ETests } from '@e2e-test/shared'

vestingE2ETests(assetHubKusama, { testSuiteName: 'Kusama Asset Hub Vesting', addressEncoding: 2 })
