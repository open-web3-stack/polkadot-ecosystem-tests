import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { type BountiesTestConfig, baseBountiesE2ETests, registerTestTree } from '@e2e-test/shared'

const testConfig: BountiesTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Bounties',
  // `OnSlash = pallet_dap::DapLegacyAdapter` in the runtime's `treasury.rs`: slashes go to the DAP staging account.
  slashDestination: 'dapStaging',
  // `SmallTipper = 250 * DOLLARS` in the runtime's `governance/origins.rs`; 1 DOT is 10^10 plancks.
  smallTipperSpendLimit: 2_500_000_000_000n,
  // `Treasurer = 10_000 * GRAND`, where `GRAND` is 1,000 DOT.
  treasurerSpendLimit: 100_000_000_000_000_000n,
  usdtAssetId: assetHubPolkadot.custom.usdtIndex,
}

registerTestTree(baseBountiesE2ETests(assetHubPolkadot, testConfig))
