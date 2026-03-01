import { defaultAccounts } from '@e2e-test/networks'
import { acala, assetHubPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('acala & assetHubPolkadot', async () => {
  const [assetHubPolkadotClient, acalaClient] = await setupNetworks(assetHubPolkadot, acala)

  const acalaDOT = acala.custom.dot
  const assetHubDOT = assetHubPolkadot.custom.dot

  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to acala', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: acalaClient,
      fromBalance: query.balances,
      toBalance: query.tokens(acalaDOT),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(assetHubDOT, 1e12, tx.xcmPallet.parachainV3(1, acala.paraId!)),
    }
  })

  runXtokenstHorizontal('acala transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: acalaClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.tokens(acalaDOT),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(acalaDOT, 1e12, tx.xtokens.parachainV3(assetHubPolkadot.paraId!)),
    }
  })

  runXtokenstHorizontal('acala transfer DOT to assetHubPolkadot with limited weight', async () => {
    return {
      fromChain: acalaClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.tokens(acalaDOT),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(acalaDOT, 1e12, tx.xtokens.parachainV3(assetHubPolkadot.paraId!), {
        Limited: { refTime: 5000000000, proofSize: 10000 },
      }),
    }
  })

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

  runXcmPalletHorizontal('assetHubPolkadot transfer ETH to acala', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: acalaClient,
      fromBalance: query.foreignAssets(assetHubPolkadot.custom.eth),
      toBalance: query.tokens(acala.custom.eth),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, acala.paraId!),
        [
          {
            id: assetHubPolkadot.custom.eth,
            fun: { Fungible: 10n ** 17n },
          },
        ],
        'LocalReserve',
        assetHubPolkadot.custom.eth,
        'LocalReserve',
      ),
    }
  })

  runXcmPalletHorizontal('acala transfer ETH to assetHubPolkadot', async () => {
    await acalaClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccounts.alice.address, acala.custom.eth], { free: 10n ** 18n }]],
        TotalIssuance: [[[acala.custom.eth], 10n ** 19n]],
      },
    })

    return {
      fromChain: acalaClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.tokens(acala.custom.eth),
      toBalance: query.foreignAssets(assetHubPolkadot.custom.eth),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, assetHubPolkadot.paraId!),
        [
          {
            id: assetHubPolkadot.custom.eth,
            fun: { Fungible: 10n ** 17n },
          },
        ],
        'DestinationReserve',
        assetHubPolkadot.custom.eth,
        'DestinationReserve',
      ),
    }
  })
})
