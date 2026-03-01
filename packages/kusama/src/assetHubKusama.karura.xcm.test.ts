import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, karura } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubKusama & karura', async () => {
  const [assetHubKusamaClient, karuraClient] = await setupNetworks(assetHubKusama, karura)

  const assetHubKusamaUsdt = assetHubKusama.custom.usdtIndex
  const karuraUsdt = karura.custom.usdt
  const karuraKSM = karura.custom.ksm

  runXcmPalletHorizontal('assetHubKusama transfer KSM to karura', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: karuraClient,
      fromBalance: query.balances,
      toBalance: query.tokens(karuraKSM),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, karura.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        'LocalReserve',
        { parents: 1, interior: 'Here' },
        'LocalReserve',
      ),
    }
  })

  runXtokenstHorizontal('karura transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: karuraClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.tokens(karuraKSM),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(karuraKSM, 1e12, tx.xtokens.parachainV4(assetHubKusama.paraId!)),
    }
  })

  runXtokenstHorizontal('karura transfer KSM to assetHubKusama with limited weight', async () => {
    return {
      fromChain: karuraClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.tokens(karuraKSM),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(karuraKSM, 1e12, tx.xtokens.parachainV4(assetHubKusama.paraId!), {
        Limited: { refTime: 500000000, proofSize: 10000 },
      }),
    }
  })

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
      precision: 1,
    }
  })
})
