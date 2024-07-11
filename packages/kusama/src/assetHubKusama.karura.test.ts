import { afterAll, beforeEach, describe } from 'vitest'
import { defaultAccount } from '@e2e-test/shared'

import { assetHubKusama, karura } from '@e2e-test/networks/chains'
import { captureSnapshot, createNetworks } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

describe('assetHubKusama & karura', async () => {
  const [assetHubKusamaClient, karuraClient] = await createNetworks(assetHubKusama, karura)

  const restoreSnapshot = captureSnapshot(assetHubKusamaClient, karuraClient)

  const assetHubKusamaUsdt = assetHubKusamaClient.config.custom.usdtIndex
  const karuraUsdt = karuraClient.config.custom.usdt

  beforeEach(restoreSnapshot)

  afterAll(async () => {
    await assetHubKusamaClient.teardown()
    await karuraClient.teardown()
  })

  runXcmPalletHorizontal('assetHubKusama transfer USDT to karura', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: karuraClient,
      fromBalance: query.assets(assetHubKusamaUsdt),
      toBalance: query.tokens(karuraUsdt),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        assetHubKusamaClient.config.custom.usdt,
        1e6,
        tx.xcmPallet.parachainV3(1, karuraClient.config.paraId!),
      ),
    }
  })

  runXtokenstHorizontal('karura transfer USDT to assetHubKusama', async () => {
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
      tx: tx.xtokens.transfer(karuraUsdt, 1e6, tx.xtokens.parachainV4(assetHubKusamaClient.config.paraId!)),
    }
  })
})
