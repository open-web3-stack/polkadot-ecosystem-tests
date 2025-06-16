import { describe } from 'vitest'

import { acala, assetHubPolkadot, integriteePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

describe('integriteePolkadot & assetHubPolkadot', async () => {
  const [assetHubPolkadotClient, integriteePolkadotClient] = await setupNetworks(assetHubPolkadot, integriteePolkadot)

  const integriteeDOT = integriteePolkadot.custom.xcmRelayNative
  const integriteeRelayNativeAssetId = integriteePolkadot.custom.assetIdRelayNative
  const polkadotDOT = assetHubPolkadot.custom.dot

  const integriteeTEER = integriteePolkadot.custom.xcmTeer
  const assetHubTEER = { Concrete: { parents: 1, interior: { X1: [{ Parachain: integriteePolkadot.paraId! }] } } }

  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to integriteePolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: integriteePolkadotClient,
      fromBalance: query.balances,
      toBalance: query.assets(integriteeRelayNativeAssetId),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        polkadotDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, integriteePolkadot.paraId!),
      ),
    }
  })

  runXcmPalletHorizontal('integriteePolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: integriteePolkadotClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.assets(integriteeRelayNativeAssetId),
      toBalance: query.balances,
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        integriteeDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubPolkadot.paraId!),
      ),
    }
  })

  // runXcmPalletHorizontal('integriteePolkadot transfer TEER to assetHubPolkadot', async () => {
  //   return {
  //     fromChain: integriteePolkadotClient,
  //     toChain: assetHubPolkadotClient,
  //     fromBalance: query.balances,
  //     toBalance: query.foreignAssets(assetHubTEER),
  //     tx: tx.xcmPallet.transferAssetsV3(
  //       integriteeTEER,
  //       1e12,
  //       tx.xcmPallet.parachainV3(1, assetHubPolkadot.paraId!),
  //     ),
  //   }
  // })

  // runXcmPalletHorizontal('assetHubPolkadot transfer TEER to integriteePolkadot', async () => {
  //   return {
  //     fromChain: assetHubPolkadotClient,
  //     toChain: integriteePolkadotClient,
  //     fromBalance: query.foreignAssets(assetHubTEER),
  //     toBalance: query.balances,
  //     tx: tx.xcmPallet.transferAssetsUsingType(
  //       tx.xcmPallet.parachainV4(1, integriteePolkadot.paraId!),
  //       [
  //         {
  //           id: assetHubTEER,
  //           fun: { Fungible: 10n ** 12n },
  //         },
  //       ],
  //       'Teleport',
  //       assetHubTEER,
  //       'LocalReserve',
  //     ),
  //   }
  // })

  runXcmPalletHorizontal('assetHubPolkadot transfer TEER to integriteePolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: integriteePolkadotClient,
      fromBalance: query.foreignAssets(assetHubTEER.Concrete),
      toBalance: query.balances,
      tx: tx.xcmPallet.transferAssetsV3(assetHubTEER, 1e12, tx.xcmPallet.parachainV3(1, integriteePolkadot.paraId!)),
    }
  })
})
