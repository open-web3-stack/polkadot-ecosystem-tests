import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { registerTestTree, type TreasuryTestConfig, treasuryE2ETests } from '@e2e-test/shared'

/** USDT in the local `Assets` pallet, as a V5 `VersionedLocatableAsset` paid out on Asset Hub itself. */
const usdtKind = {
  V5: {
    location: { parents: 0, interior: 'Here' },
    assetId: {
      parents: 0,
      interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: assetHubPolkadot.custom.usdtIndex }] },
    },
  },
}

const testConfig: TreasuryTestConfig = {
  testSuiteName: 'Polkadot Asset Hub Treasury',
  // Native DOT. The runtime's converter treats `asset_id (1, Here)` at `Here` as native at 1:1
  // (`AssetRateWithNative`, runtimes `asset-hub-polkadot/src/treasury.rs`).
  primaryAsset: {
    kind: { V5: { location: { parents: 0, interior: 'Here' }, assetId: { parents: 1, interior: 'Here' } } },
    holding: { pallet: 'balances' },
  },
  // USDT, which has a V5 `AssetRate` entry and is held by the treasury.
  ratedAsset: { kind: usdtKind, holding: { pallet: 'assets', id: assetHubPolkadot.custom.usdtIndex } },
  // DED (asset 30) at `Here`. Its only rate entries are keyed at `(0, Parachain(1000))`, so this
  // exact kind has none.
  unratedAssetKind: {
    V5: {
      location: { parents: 0, interior: 'Here' },
      assetId: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 30 }] } },
    },
  },
  // 250 DOT (`SmallTipper = 250 * DOLLARS`, runtimes `asset-hub-polkadot/src/governance/origins.rs`).
  smallTipperLimit: 250n * 10n ** 10n,
  // Slashes go to the DAP adapter, not the treasury (`OnSlash`, `asset-hub-polkadot/src/treasury.rs`).
  slashesFundTreasury: false,
}

registerTestTree(treasuryE2ETests(assetHubPolkadot, testConfig))
