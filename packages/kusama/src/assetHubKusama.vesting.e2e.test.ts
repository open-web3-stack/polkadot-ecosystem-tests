import { assetHubKusama } from '@e2e-test/networks/chains'

import { registerTestTree } from '@e2e-test/shared'
import { assetHubVestingE2ETests } from '@e2e-test/shared'

registerTestTree(assetHubVestingE2ETests(assetHubKusama, { testSuiteName: 'Kusama Asset Hub Vesting' }))
