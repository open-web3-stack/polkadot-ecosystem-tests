import { afterAll, describe } from 'vitest'
import { connectParachains, connectVertical } from '@acala-network/chopsticks'

import { createNetwork } from '@e2e-test/networks'
import { karura, kusama } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

describe(`'karura' <-> 'kusama' xcm transfer`, async () => {
  const [kusamaClient, karuraClient] = await Promise.all([createNetwork(kusama), createNetwork(karura)])

  await connectVertical(kusamaClient.chain, karuraClient.chain)
  await connectParachains([karuraClient.chain])

  const karuraKSM = karuraClient.config.custom!.ksm
  const karuraParaId = karuraClient.config.paraId!
  const kusamaKSM = kusamaClient.config.custom!.ksm

  afterAll(async () => {
    console.log('afterAll')
    await kusamaClient.teardown()
    await karuraClient.teardown()
  })

  runXtokensUp(`'karura' -> 'kusama' KSM`, async () => {
    return {
      fromChain: karuraClient,
      toChain: kusamaClient,
      balance: query.tokens(karuraKSM),
      tx: tx.xtokens.transfer(karuraKSM, 1e12, tx.xtokens.relaychainV3),
    }
  })

  runXtokensUp(`'karura' -> 'kusama' KSM wiht limited weight`, async () => {
    return {
      fromChain: karuraClient,
      toChain: kusamaClient,
      balance: query.tokens(karuraKSM),
      tx: tx.xtokens.transfer(karuraKSM, 1e12, tx.xtokens.relaychainV3, {
        Limited: { refTime: 5000000000 },
      }),
    }
  })

  runXcmPalletDown(`'kusama' -> 'karura' KSM`, async () => {
    return {
      fromChain: kusamaClient,
      toChain: karuraClient,
      balance: query.tokens(karuraKSM),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(0, karuraParaId)),
    }
  })
})
