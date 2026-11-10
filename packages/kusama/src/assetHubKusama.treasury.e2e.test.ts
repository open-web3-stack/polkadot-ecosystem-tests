import { assetHubKusama } from '@e2e-test/networks/chains'
import { registerTestTree, type TreasuryTestConfig, treasuryE2ETests } from '@e2e-test/shared'

/** One QUID, the unit the Kusama governance tracks are denominated in (1/30 KSM). */
const QUID = 10n ** 12n / 30n

const testConfig: TreasuryTestConfig = {
  testSuiteName: 'Kusama Asset Hub Treasury',
  // Native KSM. The runtime's converter treats `asset_id (1, Here)` at `Here` as native at 1:1
  // (`AssetRateWithNative`, runtimes `asset-hub-kusama/src/treasury.rs`).
  primaryAsset: {
    kind: { V5: { location: { parents: 0, interior: 'Here' }, assetId: { parents: 1, interior: 'Here' } } },
    holding: { pallet: 'balances' },
  },
  // DOT bridged from Polkadot, held in `ForeignAssets`. It has a V5 `AssetRate` entry and the
  // treasury holds it.
  ratedAsset: {
    kind: {
      V5: {
        location: { parents: 0, interior: 'Here' },
        assetId: { parents: 2, interior: { X1: [{ GlobalConsensus: 'Polkadot' }] } },
      },
    },
    holding: { pallet: 'foreignAssets', location: { parents: 2, interior: { X1: [{ GlobalConsensus: 'Polkadot' }] } } },
  },
  // USDT, which has no `AssetRate` entry on Kusama Asset Hub.
  unratedAssetKind: {
    V5: {
      location: { parents: 0, interior: 'Here' },
      assetId: {
        parents: 0,
        interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: assetHubKusama.custom.usdtIndex }] },
      },
    },
  },
  // 250 QUID (`SmallTipper = 250 * QUID`, runtimes `asset-hub-kusama/src/governance/origins.rs`).
  smallTipperLimit: 250n * QUID,
  // Bounty slashes are paid into the treasury (`OnSlash = Treasury`, `asset-hub-kusama/src/treasury.rs`).
  slashesFundTreasury: true,
}

registerTestTree(treasuryE2ETests(assetHubKusama, testConfig))
