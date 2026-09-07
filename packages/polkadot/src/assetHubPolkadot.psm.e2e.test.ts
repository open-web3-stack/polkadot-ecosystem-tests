import { assetHubPolkadot } from '@e2e-test/networks/chains'
import { type PsmTestConfig, psmE2ETests, registerTestTree } from '@e2e-test/shared'

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
    location: {
      parents: 2,
      interior: {
        X2: [
          { GlobalConsensus: { Ethereum: { chainId: 1 } } },
          { AccountKey20: { network: null, key: '0x6b175474e89094c44da98b954eedeac495271d0f' } },
        ],
      },
    },
    decimals: 18,
  },
}

registerTestTree(psmE2ETests(assetHubPolkadot, testCfg))
