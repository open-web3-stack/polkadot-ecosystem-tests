import { afterAll, describe } from 'vitest'
import { connectParachains } from '@acala-network/chopsticks'
import { defaultAccount } from '@e2e-test/shared/helpers'

import { acala, assetHubPolkadot } from '@e2e-test/networks/chains'
import { createNetwork } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

// assetHubPolkadot <=> acala
describe(`'assetHubPolkadot' <-> 'acala' xcm transfer 'WBTC'`, async () => {
  const [assetHubPolkadotClient, acalaClient] = await Promise.all([
    createNetwork(assetHubPolkadot),
    createNetwork(acala),
  ])

  await connectParachains([assetHubPolkadotClient.chain, acalaClient.chain])

  const assetHubPolkadotWbtc = assetHubPolkadotClient.config.custom!.wbtcIndex
  const acalaWbtc = acalaClient.config.custom!.wbtc
  const acalaParaAccount = acalaClient.config.custom!.paraAccount

  afterAll(async () => {
    await assetHubPolkadotClient.teardown()
    await acalaClient.teardown()
  })

  runXcmPalletHorizontal(`'assetHubPolkadot' -> 'acala' WBTC`, async () => {
    await assetHubPolkadotClient.dev.setStorage({
      System: {
        account: [[[acalaParaAccount], { providers: 1, data: { free: 10e10 } }]],
      },
      Assets: {
        account: [[[assetHubPolkadotWbtc, defaultAccount.alice.address], { balance: 1e8 }]],
        asset: [[[assetHubPolkadotWbtc], { supply: 1e8 }]],
      },
    })

    return {
      fromChain: assetHubPolkadotClient,
      toChain: acalaClient,
      fromBalance: query.assets(assetHubPolkadotWbtc),
      toBalance: query.tokens(acalaWbtc),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        assetHubPolkadot.wbtc,
        1e7,
        tx.xcmPallet.parachainV3(1, acalaClient.config.paraId!),
      ),
    }
  })

  // TODO: this failed with FailedToTransactAsset on assetHubPolkadot somehow
  runXcmPalletHorizontal(`'acala' -> 'assetHubPolkadot' WBTC`, async () => {
    await acalaClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccount.alice.address, acala.wbtc], { free: 1e8 }]],
      },
    })

    await assetHubPolkadotClient.dev.setStorage({
      System: {
        account: [[[acalaParaAccount], { providers: 1, data: { free: 10e10 } }]],
      },
      Assets: {
        account: [
          [[assetHubPolkadotWbtc, acalaParaAccount], { balance: 10e8 }],
          [[assetHubPolkadotWbtc, defaultAccount.alice.address], { balance: 10e8 }],
        ],
        asset: [[[assetHubPolkadotWbtc], { supply: 10e8 }]],
      },
    })

    return {
      fromChain: acalaClient,
      toChain: assetHubPolkadotClient,
      fromAccount: defaultAccount.alice,
      toAccount: defaultAccount.alice,
      fromBalance: query.tokens(acalaWbtc),
      toBalance: query.assets(assetHubPolkadotWbtc),
      tx: tx.xtokens.transferMulticurrencies(
        acala.wbtc,
        1e7,
        acala.dot, // fee
        16e9,
        tx.xtokens.parachainV3(assetHubPolkadotClient.config.paraId!),
      ),
    }
  })
})
