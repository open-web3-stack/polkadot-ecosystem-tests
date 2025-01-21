import { describe } from 'vitest'

import { kusama, shiden } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

describe('kusama & shiden', async () => {
  const [kusamaClient, shidenClient] = await setupNetworks(kusama, shiden)

  const shidenKSM = shiden.custom.ksm
  const kusamaKSM = kusama.custom.ksm

  runXtokensUp('shiden transfer KSM to kusama', async () => {
    return {
      fromChain: shidenClient,
      toChain: kusamaClient,
      balance: query.assets(shidenKSM),
      tx: tx.xtokens.transfer(shidenKSM, 1e12, tx.xtokens.relaychainV3),
    }
  })

  runXcmPalletDown('kusama transfer KSM to shiden', async () => {
    return {
      fromChain: kusamaClient,
      toChain: shidenClient,
      balance: query.assets(shidenKSM),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(0, shiden.paraId!)),
    }
  })
})
