import { assetHubWestend } from '@e2e-test/networks/chains'
import { type MultiAssetBountiesTestConfig, multiAssetBountiesE2ETests, registerTestTree } from '@e2e-test/shared'

/** `CENTS` in `asset-hub-westend`: 1 WND is 100 CENTS. */
const CENTS = 10_000_000_000n

const testConfig: MultiAssetBountiesTestConfig = {
  testSuiteName: 'Westend Asset Hub Multi-Asset Bounties',
  // USDT rather than WND: the runtime's balance converter recognises WND as native only at a
  // system parachain location, not `Here`, and `AssetRate` has no entry for it, so WND bounties
  // cannot be funded.
  primaryAsset: { symbol: 'USDT', pallet: 'assets', id: assetHubWestend.custom.usdtIndex },
  // USDT is the only asset with a live `AssetRate` entry, so there is no second one to test.
  // USDC: a live local asset with no `AssetRate` entry.
  unratedAsset: { symbol: 'USDC', pallet: 'assets', id: 1337 },
  // `Spender` in `asset-hub-westend/src/governance/origins.rs`.
  smallTipperLimit: 750n * CENTS,
  // `CuratorDepositFromValueMultiplier`, `CuratorDepositMin` and `CuratorDepositMax` in
  // `asset-hub-westend/src/governance/mod.rs`.
  curatorDeposit: { multiplier: 100_000n, min: 10n * CENTS, max: 500n * CENTS },
  // The runtime refunds a closed parent's value minus what its child bounties paid out, from
  // https://github.com/paritytech/polkadot-sdk/pull/13258.
  parentRefundNetOfChildren: true,
}

registerTestTree(multiAssetBountiesE2ETests(assetHubWestend, testConfig))
