import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, integriteeKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('integriteeKusama & assetHubKusama', async () => {
  const [assetHubKusamaClient, integriteeKusamaClient] = await setupNetworks(assetHubKusama, integriteeKusama)

  const integriteeKSM = integriteeKusama.custom.ksm
  const KusamaKSM = assetHubKusama.custom.ksm

  runXcmPalletDown('assetHubKusama transfer KSM to integriteeKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: integriteeKusamaClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        KusamaKSM,
        1e12,
        tx.xcmPallet.parachainV3(1, integriteeKusama.paraId!),
      ),
    }
  })

  runXcmPalletUp('integriteeKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: integriteeKusamaClient,
      toChain: assetHubKusamaClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        integriteeKSM,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubKusamaClient.config.paraId!),
      ),
    }
  })
})
