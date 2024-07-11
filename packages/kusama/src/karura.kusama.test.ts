import { afterAll, beforeEach, describe } from 'vitest'

import { captureSnapshot, createNetworks } from '@e2e-test/networks'
import { karura, kusama } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

describe('karura & kusama', async () => {
  const [karuraClient, kusamaClient] = await createNetworks(karura, kusama)

  const restoreSnapshot = captureSnapshot(karuraClient, kusamaClient)

  beforeEach(restoreSnapshot)

  const karuraKSM = karuraClient.config.custom.ksm
  const karuraParaId = karuraClient.config.paraId!
  const kusamaKSM = kusamaClient.config.custom.ksm

  afterAll(async () => {
    await kusamaClient.teardown()
    await karuraClient.teardown()
  })

  runXtokensUp('karura transfer KSM to kusama', async () => {
    return {
      fromChain: karuraClient,
      toChain: kusamaClient,
      balance: query.tokens(karuraKSM),
      tx: tx.xtokens.transfer(karuraKSM, 1e12, tx.xtokens.relaychainV3),
    }
  })

  runXtokensUp('karura transfer KSM to kusama wiht limited weight', async () => {
    return {
      fromChain: karuraClient,
      toChain: kusamaClient,
      balance: query.tokens(karuraKSM),
      tx: tx.xtokens.transfer(karuraKSM, 1e12, tx.xtokens.relaychainV3, {
        Limited: { refTime: 500000000, proofSize: 10000 },
      }),
    }
  })

  runXcmPalletDown('kusama transfer KSM to karura', async () => {
    return {
      fromChain: kusamaClient,
      toChain: karuraClient,
      balance: query.tokens(karuraKSM),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(0, karuraParaId)),
    }
  })
})
