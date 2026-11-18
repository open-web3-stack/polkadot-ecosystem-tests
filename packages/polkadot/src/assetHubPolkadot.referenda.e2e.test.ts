import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { type ReferendaTestConfig, referendaE2ETests, registerTestTree } from '@e2e-test/shared'

const testConfig: ReferendaTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Referenda',
  // The runtime's `Slash` handler is `pallet_dap::DapLegacyAdapter`, which credits the DAP staging account.
  slashDestination: 'dapStaging',
}

registerTestTree(referendaE2ETests(assetHubPolkadot, testConfig))
