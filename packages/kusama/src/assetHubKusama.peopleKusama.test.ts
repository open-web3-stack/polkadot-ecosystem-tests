import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, peopleKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('assetHubKusama & peopleKusama', async () => {
  const [assetHubKusamaClient, peopleClient] = await setupNetworks(assetHubKusama, peopleKusama)

  const peopleKSM = peopleKusama.custom.ksm
  const kusamaKSM = assetHubKusama.custom.ksm

  runXcmPalletDown('assetHubKusama transfer KSM to peopleKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: peopleClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(1, peopleKusama.paraId!)),
    }
  })

  runXcmPalletUp('peopleKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: peopleClient,
      toChain: assetHubKusamaClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        peopleKSM,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubKusamaClient.config.paraId!),
      ),
    }
  })
})
