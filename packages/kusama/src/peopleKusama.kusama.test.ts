import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { kusama, peopleKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('kusama & peopleKusama', async () => {
  const [kusamaClient, peopleClient] = await setupNetworks(kusama, peopleKusama)

  const peopleKSM = peopleKusama.custom.ksm
  const kusamaKSM = kusama.custom.ksm

  runXcmPalletDown('kusama transfer KSM to peopleKusama', async () => {
    return {
      fromChain: kusamaClient,
      toChain: peopleClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.teleportAssetsV3(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(0, peopleKusama.paraId!)),
    }
  })

  runXcmPalletUp('peopleKusama transfer KSM to kusama', async () => {
    return {
      fromChain: peopleClient,
      toChain: kusamaClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.teleportAssetsV3(peopleKSM, 1e12, tx.xcmPallet.relaychainV4),
    }
  })
})
