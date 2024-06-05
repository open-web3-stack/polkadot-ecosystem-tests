import { afterAll, describe } from 'vitest'
import { connectParachains, connectVertical } from '@acala-network/chopsticks'

import { createNetwork } from '@e2e-test/networks'
import { kusama, shiden } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown } from '@e2e-test/shared/xcm'

describe(`'kusama' <-> 'shiden' xcm transfer`, async () => {
  const [kusamaClient, shidenClient] = await Promise.all([createNetwork(kusama), createNetwork(shiden)])

  await connectVertical(kusamaClient.chain, shidenClient.chain)
  await connectParachains([shidenClient.chain])

  const shidenKSM = shidenClient.config.custom!.ksm
  const shidenParaId = shidenClient.config.paraId!
  const kusamaKSM = kusamaClient.config.custom!.ksm

  afterAll(async () => {
    console.log('afterAll')
    await kusamaClient.teardown()
    await shidenClient.teardown()
  })

  runXcmPalletDown(`'kusama' -> 'shiden' KSM`, async () => {
    return {
      fromChain: kusamaClient,
      toChain: shidenClient,
      balance: query.assets(shidenKSM),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(0, shidenParaId)),
    }
  })
})
