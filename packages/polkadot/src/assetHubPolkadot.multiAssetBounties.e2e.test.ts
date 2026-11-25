import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { type MultiAssetBountiesTestConfig, multiAssetBountiesE2ETests, registerTestTree } from '@e2e-test/shared'

/** 1 DOT. `DOLLARS` in `system-parachains/constants/src/polkadot.rs`. */
const DOT = 10_000_000_000n

const testConfig: MultiAssetBountiesTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Multi-Asset Bounties',
  primaryAsset: { symbol: 'DOT', pallet: 'balances' },
  // USDT, priced by a live `AssetRate` entry and held by the treasury.
  secondaryAsset: { symbol: 'USDT', pallet: 'assets', id: assetHubPolkadot.custom.usdtIndex },
  // DED: a live local asset the treasury holds, with no `AssetRate` entry for its local location.
  unratedAsset: { symbol: 'DED', pallet: 'assets', id: 30 },
  // `Spender` in `asset-hub-polkadot/src/governance/origins.rs`.
  smallTipperLimit: 250n * DOT,
  // `CuratorDepositMultiplier`, `CuratorDepositMin` and `CuratorDepositMax` in
  // `asset-hub-polkadot/src/treasury.rs`.
  curatorDeposit: { multiplier: 500_000n, min: 10n * DOT, max: 200n * DOT },
  // The deployed pallet (0.6.1) refunds a closed parent's full value. Fixed upstream in
  // polkadot-sdk #13258; set this to true once a runtime with the fix is live.
  parentRefundNetOfChildren: false,
}

registerTestTree(multiAssetBountiesE2ETests(assetHubPolkadot, testConfig))
