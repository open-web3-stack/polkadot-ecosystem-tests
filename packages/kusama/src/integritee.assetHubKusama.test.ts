import { describe } from 'vitest'

import { assetHubKusama, integriteeKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

describe('integriteeKusama & assetHubKusama', async () => {
  const [assetHubKusamaClient, integriteeKusamaClient] = await setupNetworks(assetHubKusama, integriteeKusama)

  runXcmPalletHorizontal('assetHubKusama transfer KSM to integriteeKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: integriteeKusamaClient,
      fromBalance: query.balances,
      toBalance: query.assets(integriteeKusama.custom.assetIdRelayNative),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        assetHubKusama.custom.ksm,
        1e12,
        tx.xcmPallet.parachainV3(1, integriteeKusama.paraId!),
      ),
    }
  })

  runXcmPalletHorizontal('integriteeKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: integriteeKusamaClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.assets(integriteeKusama.custom.assetIdRelayNative),
      toBalance: query.balances,
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        integriteeKusama.custom.xcmRelayNative,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubKusama.paraId!),
      ),
    }
  })
})
