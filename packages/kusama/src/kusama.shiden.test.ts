import { afterAll, beforeEach, describe } from 'vitest'

import { captureSnapshot, createNetworks } from '@e2e-test/networks'
import { kusama, shiden } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

describe('kusama & shiden', async () => {
  const [kusamaClient, shidenClient] = await createNetworks(kusama, shiden)

  const restoreSnapshot = captureSnapshot(kusamaClient, shidenClient)

  beforeEach(restoreSnapshot)

  const shidenKSM = shiden.custom.ksm
  const kusamaKSM = kusama.custom.ksm

  afterAll(async () => {
    await kusamaClient.teardown()
    await shidenClient.teardown()
  })

  runXtokensUp('shiden transfer KSM to kusama', async () => {
    return {
      fromChain: shidenClient,
      toChain: kusamaClient,
      balance: query.tokens(kusamaKSM),
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
