import { defaultAccountsSr25519 } from '@e2e-test/networks'
import { assetHubKusama, integriteeKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('integriteeKusama & assetHubKusama', async () => {
  const [assetHubKusamaClient, integriteeKusamaClient] = await setupNetworks(assetHubKusama, integriteeKusama)

  runXcmPalletHorizontal(
    'assetHubKusama transfer KSM to integriteeKusama',
    async () => {
      return {
        fromChain: assetHubKusamaClient,
        toChain: integriteeKusamaClient,
        fromAccount: defaultAccountsSr25519.alice,
        toAccount: defaultAccountsSr25519.bob,
        fromBalance: query.balances,
        toBalance: query.assets(integriteeKusama.custom.assetIdRelayNative),
        tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
          assetHubKusama.custom.ksm,
          1e12,
          tx.xcmPallet.parachainV3(1, integriteeKusama.paraId!),
        ),
      }
    },
    { skip: true },
  )

  runXcmPalletHorizontal('integriteeKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: integriteeKusamaClient,
      toChain: assetHubKusamaClient,
      fromAccount: defaultAccountsSr25519.alice,
      toAccount: defaultAccountsSr25519.bob,
      fromBalance: query.assets(integriteeKusama.custom.assetIdRelayNative),
      toBalance: query.balances,
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        integriteeKusama.custom.xcmRelayNative,
        // if its too much, it exhausts the sibling reserve. if its too little assets will be trapped because fees are higher than amount
        1e9,
        tx.xcmPallet.parachainV3(1, assetHubKusama.paraId!),
      ),
    }
  })
})
