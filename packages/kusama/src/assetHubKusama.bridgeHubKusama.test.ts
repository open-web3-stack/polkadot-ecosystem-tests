import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, bridgeHubKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('assetHubKusama & bridgeHubKusama', async () => {
  const [assetHubKusamaClient, bridgeHubKusamaClient] = await setupNetworks(assetHubKusama, bridgeHubKusama)

  const bridgeHubKSM = bridgeHubKusama.custom.ksm
  const assetHubKSM = assetHubKusama.custom.ksm

  runXcmPalletDown('assetHubKusama transfer KSM to bridgeHubKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: bridgeHubKusamaClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(assetHubKSM, 1e12, tx.xcmPallet.parachainV3(1, bridgeHubKusama.paraId!)),
    }
  })

  runXcmPalletUp('bridgeHubKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: bridgeHubKusamaClient,
      toChain: assetHubKusamaClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        bridgeHubKSM,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubKusamaClient.config.paraId!),
      ),
    }
  })
})
