import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { bridgeHubKusama, kusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('kusama & bridgeHubKusama', async () => {
  const [kusamaClient, bridgeHubClient] = await setupNetworks(kusama, bridgeHubKusama)

  const bridgeHubKSM = bridgeHubKusama.custom.ksm
  const kusamaKSM = kusama.custom.ksm

  runXcmPalletDown('kusama transfer KSM to bridgeHubKusama', async () => {
    return {
      fromChain: kusamaClient,
      toChain: bridgeHubClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.teleportAssetsV3(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(0, bridgeHubKusama.paraId!)),
      totalIssuanceProvider: () => query.totalIssuance(kusamaClient),
    }
  })

  runXcmPalletUp('bridgeHubKusama transfer KSM to kusama', async () => {
    return {
      fromChain: bridgeHubClient,
      toChain: kusamaClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.teleportAssetsV3(bridgeHubKSM, 1e12, tx.xcmPallet.relaychainV4),
      totalIssuanceProvider: () => query.totalIssuance(kusamaClient),
    }
  })
})
