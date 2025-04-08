import { polkadot } from '@e2e-test/networks/chains'

import { vestingE2ETests } from '@e2e-test/shared'

vestingE2ETests(polkadot, { testSuiteName: 'Polkadot Asset Hub Vesting', addressEncoding: 0 })
