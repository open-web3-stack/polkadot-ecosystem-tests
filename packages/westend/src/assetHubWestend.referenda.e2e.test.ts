import { assetHubWestend } from '@e2e-test/networks/chains'
import { type ReferendaTestConfig, referendaSubmissionDepositSlashE2ETests, registerTestTree } from '@e2e-test/shared'

const testConfig: ReferendaTestConfig = {
  testSuiteName: 'Westend Asset Hub Referenda',
  // The runtime's `Slash` handler is `pallet_dap::DapLegacyAdapter`, which credits the DAP staging account.
  slashDestination: 'dapStaging',
}

// Only the submission deposit slash tests are registered. The runtime's weights for
// `place_decision_deposit` and `nudge_referendum` exceed what a block allows, so the tests of
// `referendaE2ETests` that take a referendum past submission cannot run here. See
// https://github.com/paritytech/polkadot-sdk/issues/13900.
registerTestTree(referendaSubmissionDepositSlashE2ETests(assetHubWestend, testConfig))
