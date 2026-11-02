import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { type PsmTestConfig, psmE2ETests, registerTestTree } from '@e2e-test/shared'

/** Location of an ERC-20 bridged from Ethereum mainnet, as ForeignAssets holds it. */
const ethereumAsset = (key: string) => ({
  parents: 2,
  interior: {
    X2: [{ GlobalConsensus: { Ethereum: { chainId: 1 } } }, { AccountKey20: { network: null, key } }],
  },
})

const testCfg: PsmTestConfig = {
  testSuiteName: 'Polkadot Asset Hub PSM',
  // Unused local asset id; the suite injects its own 6-decimal internal stablecoin here.
  internalAssetId: 50000342,
  // USDT and USDC, both live 6-decimal assets in the local Assets pallet.
  primaryExternalId: assetHubPolkadot.custom.usdtIndex,
  secondaryExternalId: assetHubPolkadot.custom.usdcIndex,
  // Bridged DAI, an 18-decimal ForeignAssets entry. A dollar stablecoin is the only sensible
  // PSM collateral, since the pallet swaps at parity once decimals are scaled; DAI's 18 decimals
  // exercise that scaling and the foreign half of the asset union the PSM is configured over.
  foreignExternal: {
    location: ethereumAsset('0x6b175474e89094c44da98b954eedeac495271d0f'),
    decimals: 18,
  },
  // Approved only to reach the cap on approved externals; never swapped, so their economics do
  // not matter. Bridged WETH, sUSDe and sUSDS.
  capFillerExternals: [
    ethereumAsset('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
    ethereumAsset('0x9d39a5de30e57443bff2a8307a4256c8797a3497'),
    ethereumAsset('0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'),
  ],
}

registerTestTree(psmE2ETests(assetHubPolkadot, testCfg))
