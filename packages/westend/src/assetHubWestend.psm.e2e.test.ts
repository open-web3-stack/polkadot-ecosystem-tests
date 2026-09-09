import { assetHubWestend } from '@e2e-test/networks/chains'
import { type PsmTestConfig, psmE2ETests, registerTestTree } from '@e2e-test/shared'

const testCfg: PsmTestConfig = {
  testSuiteName: 'Westend Asset Hub PSM',
  // Live pUSD. The suite overwrites its asset entry to take ownership, since creating a PSM
  // requires a signed origin that owns the internal asset.
  internalAssetId: 50000342,
  // Test-Tether and USDC, both live 6-decimal assets in the local Assets pallet.
  primaryExternalId: assetHubWestend.custom.usdtIndex,
  secondaryExternalId: 31337,
  // Hollar, an 18-decimal stablecoin held in ForeignAssets. A dollar stablecoin is the only
  // sensible PSM collateral, since the pallet swaps at parity once decimals are scaled; the
  // decimal gap exercises that scaling and the foreign half of the PSM's asset union.
  foreignExternal: {
    location: { parents: 1, interior: { X2: [{ Parachain: 2034 }, { GeneralIndex: 222 }] } },
    decimals: 18,
  },
  // Approved only to reach the cap on approved externals; never swapped, so their economics do
  // not matter. Bridged ether and WETH from Sepolia, and Mythos.
  capFillerExternals: [
    { parents: 2, interior: { X1: [{ GlobalConsensus: { Ethereum: { chainId: 11155111 } } }] } },
    {
      parents: 2,
      interior: {
        X2: [
          { GlobalConsensus: { Ethereum: { chainId: 11155111 } } },
          { AccountKey20: { network: null, key: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' } },
        ],
      },
    },
    { parents: 1, interior: { X1: [{ Parachain: 3368 }] } },
  ],
}

registerTestTree(psmE2ETests(assetHubWestend, testCfg))
