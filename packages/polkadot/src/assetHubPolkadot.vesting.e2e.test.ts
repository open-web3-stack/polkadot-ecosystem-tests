import { assetHubPolkadot } from '@e2e-test/networks/chains'

import { assetHubVestingE2ETests, registerTestTree } from '@e2e-test/shared'

registerTestTree(assetHubVestingE2ETests(assetHubPolkadot, { testSuiteName: 'Polkadot Asset Hub Vesting' }))
