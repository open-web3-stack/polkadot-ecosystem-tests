import { afterAll, describe } from 'vitest'
import { connectParachains } from '@acala-network/chopsticks'
import { defaultAccount } from '@e2e-test/shared/helpers'

import { assetHubKusama, karura } from '@e2e-test/networks/chains'
import { createNetwork } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

// assetHubKusama <=> karura
describe(`'assetHubKusama' <-> 'karura' xcm transfer 'USDT'`, async () => {
  const [assetHubKusamaClient, karuraClient] = await Promise.all([createNetwork(assetHubKusama), createNetwork(karura)])

  await connectParachains([assetHubKusamaClient.chain, karuraClient.chain])

  const assetHubKusamaUsdt = assetHubKusamaClient.config.custom!.usdtIndex
  const karuraUsdt = karuraClient.config.custom!.usdt

  afterAll(async () => {
    await assetHubKusamaClient.teardown()
    await karuraClient.teardown()
  })

  runXcmPalletHorizontal(`'assetHubKusama' -> 'karura' USDT`, async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: karuraClient,
      fromBalance: query.assets(assetHubKusamaUsdt),
      toBalance: query.tokens(karuraUsdt),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        assetHubKusamaClient.config.custom!.usdt,
        1e6,
        tx.xcmPallet.parachainV3(1, karuraClient.config.paraId!),
      ),
    }
  })

  runXcmPalletHorizontal(`'karura' -> 'assetHubKusama' USDT`, async () => {
    await karuraClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccount.alice.address, karuraUsdt], { free: 10e6 }]],
      },
    })

    return {
      fromChain: karuraClient,
      toChain: assetHubKusamaClient,
      fromAccount: defaultAccount.alice,
      toAccount: defaultAccount.alice,
      fromBalance: query.tokens(karuraUsdt),
      toBalance: query.assets(assetHubKusamaUsdt),
      tx: tx.xtokens.transfer(karuraUsdt, 1e6, tx.xtokens.parachainV3(assetHubKusamaClient.config.paraId!)),
    }
  })
})
