import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, bridgeHubKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubKusama & bridgeHubKusama', async () => {
  const [assetHubKusamaClient, bridgeHubKusamaClient] = await setupNetworks(assetHubKusama, bridgeHubKusama)

  const bridgeHubKSM = bridgeHubKusama.custom.ksm
  const assetHubKSM = assetHubKusama.custom.ksm

  runXcmPalletHorizontal('assetHubKusama transfer KSM to bridgeHubKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: bridgeHubKusamaClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(assetHubKSM, 1e12, tx.xcmPallet.parachainV3(1, bridgeHubKusama.paraId!)),
    }
  })

  runXcmPalletHorizontal('bridgeHubKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: bridgeHubKusamaClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        bridgeHubKSM,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubKusamaClient.config.paraId!),
      ),
    }
  })
})
