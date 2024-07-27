import { describe } from 'vitest'

import { acala, assetHubPolkadot } from '@e2e-test/networks/chains'
import { defaultAccounts } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('acala & assetHubPolkadot', async () => {
  const [assetHubPolkadotClient, acalaClient] = await setupNetworks(assetHubPolkadot, acala)

  runXcmPalletHorizontal('assetHubPolkadot transfer USDT to acala', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: acalaClient,
      fromBalance: query.assets(assetHubPolkadot.custom.usdtIndex),
      toBalance: query.tokens(acala.custom.usdt),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        assetHubPolkadot.custom.usdt,
        1e6,
        tx.xcmPallet.parachainV3(1, acala.paraId!),
      ),
    }
  })

  runXtokenstHorizontal('acala transfer USDT to assetHubPolkadot', async () => {
    await acalaClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccounts.alice.address, acala.custom.usdt], { free: 10e6 }]],
      },
    })

    return {
      fromChain: acalaClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.tokens(acala.custom.usdt),
      toBalance: query.assets(assetHubPolkadot.custom.usdtIndex),
      tx: tx.xtokens.transfer(acala.custom.usdt, 1e6, tx.xtokens.parachainV3(assetHubPolkadot.paraId!)),
      precision: 1,
    }
  })
})
