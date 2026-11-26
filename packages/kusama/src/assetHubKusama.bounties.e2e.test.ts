import { assetHubKusama } from '@e2e-test/networks/chains'
import { type BountiesTestConfig, baseBountiesE2ETests, registerTestTree } from '@e2e-test/shared'

const testConfig: BountiesTestConfig = {
  testSuiteName: 'Kusama Asset Hub Bounties',
  // `OnSlash = Treasury` in the runtime's `treasury.rs`: slashes go to the treasury pot.
  slashDestination: 'treasury',
  // `SmallTipper = 250 * QUID` in the runtime's `governance/origins.rs`; `QUID` is 10^12 / 30 plancks.
  smallTipperSpendLimit: 8_333_333_333_250n,
  // `Treasurer = 10_000 * GRAND`, where `GRAND` is 1,000 QUID.
  treasurerSpendLimit: 333_333_333_330_000_000n,
  usdtAssetId: assetHubKusama.custom.usdtIndex,
}

registerTestTree(baseBountiesE2ETests(assetHubKusama, testConfig))
