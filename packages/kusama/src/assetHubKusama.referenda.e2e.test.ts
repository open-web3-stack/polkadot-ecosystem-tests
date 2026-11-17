import { assetHubKusama } from '@e2e-test/networks/chains'
import { type ReferendaTestConfig, referendaE2ETests, registerTestTree } from '@e2e-test/shared'

const testConfig: ReferendaTestConfig = {
  testSuiteName: 'Kusama Asset Hub Referenda',
  // The runtime's `Slash` handler is `pallet_treasury`, which credits the treasury pot.
  slashDestination: 'treasury',
}

registerTestTree(referendaE2ETests(assetHubKusama, testConfig))
