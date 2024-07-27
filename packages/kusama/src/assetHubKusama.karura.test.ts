import { describe } from 'vitest'

import { assetHubKusama, karura } from '@e2e-test/networks/chains'
import { defaultAccounts } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('assetHubKusama & karura', async () => {
  const [assetHubKusamaClient, karuraClient] = await setupNetworks(assetHubKusama, karura)

  const assetHubKusamaUsdt = assetHubKusama.custom.usdtIndex
  const karuraUsdt = karura.custom.usdt

  runXcmPalletHorizontal('assetHubKusama transfer USDT to karura', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: karuraClient,
      fromBalance: query.assets(assetHubKusamaUsdt),
      toBalance: query.tokens(karuraUsdt),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        assetHubKusama.custom.usdt,
        1e6,
        tx.xcmPallet.parachainV3(1, karura.paraId!),
      ),
    }
  })

  runXtokenstHorizontal('karura transfer USDT to assetHubKusama', async () => {
    await karuraClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccounts.alice.address, karuraUsdt], { free: 10e6 }]],
      },
    })

    return {
      fromChain: karuraClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.tokens(karuraUsdt),
      toBalance: query.assets(assetHubKusamaUsdt),
      tx: tx.xtokens.transfer(karuraUsdt, 1e6, tx.xtokens.parachainV4(assetHubKusama.paraId!)),
      precision: 2,
    }
  })
})
