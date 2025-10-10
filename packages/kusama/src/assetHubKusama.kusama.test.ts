import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, kusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('kusama & assetHubKusama', async () => {
  const [kusamaClient, assetHubClient] = await setupNetworks(kusama, assetHubKusama)

  const assetHubKSM = assetHubKusama.custom.ksm
  const kusamaKSM = kusama.custom.ksm

  runXcmPalletDown(
    'kusama transfer KSM to assetHubKusama',
    async () => {
      return {
        fromChain: kusamaClient,
        toChain: assetHubClient,
        balance: query.balances,
        toAccount: defaultAccounts.dave,
        tx: tx.xcmPallet.teleportAssetsV3(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(0, assetHubKusama.paraId!)),
        totalIssuanceProvider: () => query.totalIssuance(kusamaClient),
      }
    },
    { skip: true },
  )

  runXcmPalletUp('assetHubKusama transfer KSM to kusama', async () => {
    return {
      fromChain: assetHubClient,
      toChain: kusamaClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.teleportAssetsV3(assetHubKSM, 1e12, tx.xcmPallet.relaychainV4),
      totalIssuanceProvider: () => query.totalIssuance(kusamaClient),
    }
  })
})
