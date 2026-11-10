import { assetHubKusama } from '@e2e-test/networks/chains'
import { type MultiAssetBountiesTestConfig, multiAssetBountiesE2ETests, registerTestTree } from '@e2e-test/shared'

/** `QUID` and `CENTS` in `system-parachains/constants/src/kusama.rs`: 1 KSM is 30 QUID. */
const QUID = 1_000_000_000_000n / 30n
const CENTS = QUID / 100n

const testConfig: MultiAssetBountiesTestConfig = {
  testSuiteName: 'Kusama Asset Hub Multi-Asset Bounties',
  primaryAsset: { symbol: 'KSM', pallet: 'balances' },
  // DOT bridged from Polkadot, priced by a live `AssetRate` entry and held by the treasury.
  secondaryAsset: {
    symbol: 'DOT',
    pallet: 'foreignAssets',
    location: { parents: 2, interior: { X1: [{ GlobalConsensus: 'Polkadot' }] } },
  },
  // USDT: a live local asset with no `AssetRate` entry.
  unratedAsset: { symbol: 'USDT', pallet: 'assets', id: assetHubKusama.custom.usdtIndex },
  // `Spender` in `asset-hub-kusama/src/governance/origins.rs`.
  smallTipperLimit: 250n * QUID,
  // `CuratorDepositMultiplier`, `CuratorDepositMin` and `CuratorDepositMax` in
  // `asset-hub-kusama/src/treasury.rs`.
  curatorDeposit: { multiplier: 500_000n, min: 10n * CENTS, max: 500n * CENTS },
  // The deployed pallet (0.6.1) refunds a closed parent's full value. Fixed upstream in
  // polkadot-sdk #13258; set this to true once a runtime with the fix is live.
  parentRefundNetOfChildren: false,
}

registerTestTree(multiAssetBountiesE2ETests(assetHubKusama, testConfig))
