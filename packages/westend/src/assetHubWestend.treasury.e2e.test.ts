import { assetHubWestend } from '@e2e-test/networks/chains'
import { registerTestTree, type TreasuryTestConfig, treasuryE2ETests } from '@e2e-test/shared'

/** USDT in the local `Assets` pallet, as a V5 `VersionedLocatableAsset` paid out on Asset Hub itself. */
const usdt: TreasuryTestConfig['primaryAsset'] = {
  kind: {
    V5: {
      location: { parents: 0, interior: 'Here' },
      assetId: {
        parents: 0,
        interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: assetHubWestend.custom.usdtIndex }] },
      },
    },
  },
  holding: { pallet: 'assets', id: assetHubWestend.custom.usdtIndex },
}

const testConfig: TreasuryTestConfig = {
  testSuiteName: 'Westend Asset Hub Treasury',
  // USDT rather than WND: this runtime's converter only treats native at `(0, Parachain(_))` as
  // 1:1 and has no rate for native at `Here`, so a WND spend cannot be approved
  // (`TreasuryBalanceConverter`, polkadot-sdk `asset-hub-westend/src/governance/mod.rs`).
  primaryAsset: usdt,
  // USDT has a V5 `AssetRate` entry and is held by the treasury.
  ratedAsset: usdt,
  // Native WND at `Here`, for the reason above.
  unratedAssetKind: { V5: { location: { parents: 0, interior: 'Here' }, assetId: { parents: 1, interior: 'Here' } } },
  // 7.5 WND (`SmallTipper = 250 * 3 * CENTS`, polkadot-sdk `asset-hub-westend/src/governance/origins.rs`).
  smallTipperLimit: 750n * 10n ** 10n,
  // Nothing routes slashes into this treasury.
  slashesFundTreasury: false,
}

registerTestTree(treasuryE2ETests(assetHubWestend, testConfig))
