import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { baseChildBountiesE2ETests, type ChildBountiesTestConfig, registerTestTree } from '@e2e-test/shared'

const testConfig: ChildBountiesTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Child Bounties',
  // Asset Hub Polkadot routes slashed bounty curator deposits through `pallet_dap::DapLegacyAdapter`, into the DAP
  // staging account.
  curatorSlashSink: 'dapStaging',
}

registerTestTree(baseChildBountiesE2ETests(assetHubPolkadot, testConfig))
