import { assetHubPaseo } from '@e2e-test/networks/chains'
import { nominationPoolsE2ETests } from '@e2e-test/shared'

nominationPoolsE2ETests(assetHubPaseo, { testSuiteName: 'Paseo Asset Hub Nomination Pools', addressEncoding: 0 })
