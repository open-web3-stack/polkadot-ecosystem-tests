import { coretimeKusama, kusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('kusama & coretimeKusama', async () => {
  const [kusamaClient, coretimeClient] = await setupNetworks(kusama, coretimeKusama)

  const coretimeKSM = coretimeKusama.custom.ksm
  const kusamaKSM = kusama.custom.ksm

  runXcmPalletDown(
    'kusama transfer KSM to coretimeKusama',
    async () => {
      return {
        fromChain: kusamaClient,
        toChain: coretimeClient,
        balance: query.balances,
        tx: tx.xcmPallet.teleportAssetsV3(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(0, coretimeKusama.paraId!)),
        totalIssuanceProvider: () => query.totalIssuance(kusamaClient),
      }
    },
    { skip: true },
  )

  runXcmPalletUp(
    'coretimeKusama transfer KSM to kusama',
    async () => {
      return {
        fromChain: coretimeClient,
        toChain: kusamaClient,
        balance: query.balances,
        tx: tx.xcmPallet.teleportAssetsV3(coretimeKSM, 1e12, tx.xcmPallet.relaychainV4),
        totalIssuanceProvider: () => query.totalIssuance(kusamaClient),
      }
    },
    { skip: true },
  )
})
