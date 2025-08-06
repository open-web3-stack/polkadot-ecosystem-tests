import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, peopleKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubKusama & peopleKusama', async () => {
  const [assetHubKusamaClient, peopleClient] = await setupNetworks(assetHubKusama, peopleKusama)

  const peopleKSM = peopleKusama.custom.ksm
  const kusamaKSM = assetHubKusama.custom.ksm

  runXcmPalletHorizontal('assetHubKusama transfer KSM to peopleKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: peopleClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(1, peopleKusama.paraId!)),
    }
  })

  runXcmPalletHorizontal('peopleKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: peopleClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        peopleKSM,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubKusamaClient.config.paraId!),
      ),
    }
  })
})
