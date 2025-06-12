import { describe } from 'vitest'

import { assetHubKusama, integriteeKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

describe('integriteeKusama & assetHubKusama', async () => {
  const [assetHubKusamaClient, integriteeKusamaClient] = await setupNetworks(assetHubKusama, integriteeKusama)

  const integriteeKSM = integriteeKusama.custom.relayNative
  const kusamaKSM = assetHubKusama.custom.ksm

  const integriteeTEER = integriteeKusama.custom.teerK
  const assetHubTEER = { Concrete: { parents: 1, interior: { X1: [{ Parachain: integriteeKusama.paraId! }] } } }

  runXcmPalletHorizontal('assetHubKusama transfer KSM to integriteeKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: integriteeKusamaClient,
      fromBalance: query.balances,
      toBalance: query.assets(integriteeKSM),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        kusamaKSM,
        1e12,
        tx.xcmPallet.parachainV3(1, integriteeKusama.paraId!),
      ),
    }
  })

  runXcmPalletHorizontal('integriteeKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: integriteeKusamaClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.assets(integriteeKSM),
      toBalance: query.balances,
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        integriteeKSM,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubKusama.paraId!),
      ),
    }
  })

  runXcmPalletHorizontal('integriteeKusama transfer TEER to assetHubKusama', async () => {
    return {
      fromChain: integriteeKusamaClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.balances,
      toBalance: query.foreignAssets(assetHubTEER),
      tx: tx.xcmPallet.limitedTeleportAssets(integriteeTEER, 1e12, tx.xcmPallet.parachainV3(1, assetHubKusama.paraId!)),
    }
  })

  runXcmPalletHorizontal('assetHubKusama transfer TEER to integriteeKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: integriteeKusamaClient,
      fromBalance: query.foreignAssets(assetHubTEER),
      toBalance: query.balances,
      tx: tx.xcmPallet.limitedTeleportAssets(assetHubTEER, 1e12, tx.xcmPallet.parachainV3(1, integriteeKusama.paraId!)),
    }
  })
})
