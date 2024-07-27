import { describe } from 'vitest'

import { acala, moonbeam, polkadot } from '@e2e-test/networks/chains'
import { defaultAccounts } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('acala & moonbeam', async () => {
  const [acalaClient, moonbeamClient, polkadotClient] = await setupNetworks(acala, moonbeam, polkadot)

  const acalaDot = acala.custom.dot
  const moonbeamDot = moonbeam.custom.dot

  runXtokenstHorizontal('acala transfer DOT to moonbeam', async () => {
    return {
      fromChain: acalaClient,
      fromBalance: query.tokens(acalaDot),
      fromAccount: defaultAccounts.alice,

      toChain: moonbeamClient,
      toBalance: query.assets(moonbeamDot),
      toAccount: defaultAccounts.alith,

      routeChain: polkadotClient,
      isCheckUmp: true,

      tx: tx.xtokens.transfer(acalaDot, 1e12, tx.xtokens.parachainAccountId20V3(moonbeam.paraId!)),
    }
  })

  runXtokenstHorizontal('moonbeam transfer DOT to acala', async () => {
    await moonbeamClient.dev.setStorage({
      Assets: {
        account: [[[moonbeamDot, defaultAccounts.alith.address], { balance: 10e12 }]],
      },
    })

    return {
      fromChain: moonbeamClient,
      fromBalance: query.assets(moonbeamDot),
      fromAccount: defaultAccounts.alith,

      toChain: acalaClient,
      toBalance: query.tokens(acalaDot),
      toAccount: defaultAccounts.alice,

      routeChain: polkadotClient,
      isCheckUmp: true,

      tx: tx.xtokens.transfer({ ForeignAsset: moonbeamDot }, 1e12, tx.xtokens.parachainV3(acala.paraId!)),
    }
  })

  runXtokenstHorizontal('acala transfer ACA to moonbeam', async () => {
    return {
      fromChain: acalaClient,
      fromBalance: query.balances,
      fromAccount: defaultAccounts.alice,

      toChain: moonbeamClient,
      toBalance: query.assets(moonbeam.custom.aca),
      toAccount: defaultAccounts.baltathar,

      tx: tx.xtokens.transfer(acala.custom.aca, 1e12, tx.xtokens.parachainAccountId20V3(moonbeam.paraId!)),
    }
  })

  runXtokenstHorizontal('moonbeam transfer ACA to acala', async () => {
    await moonbeamClient.dev.setStorage({
      Assets: {
        account: [[[moonbeam.custom.aca, defaultAccounts.alith.address], { balance: 10e12 }]],
      },
    })

    return {
      fromChain: moonbeamClient,
      fromBalance: query.assets(moonbeam.custom.aca),
      fromAccount: defaultAccounts.alith,

      toChain: acalaClient,
      toBalance: query.balances,
      toAccount: defaultAccounts.bob,

      tx: tx.xtokens.transfer({ ForeignAsset: moonbeam.custom.aca }, 1e12, tx.xtokens.parachainV3(acala.paraId!)),
    }
  })

  runXtokenstHorizontal('acala transfer LDOT to moonbeam', async () => {
    return {
      fromChain: acalaClient,
      fromBalance: query.tokens(acala.custom.ldot),
      fromAccount: defaultAccounts.alice,

      toChain: moonbeamClient,
      toBalance: query.assets(moonbeam.custom.ldot),
      toAccount: defaultAccounts.baltathar,

      tx: tx.xtokens.transfer(acala.custom.ldot, 1e12, tx.xtokens.parachainAccountId20V3(moonbeam.paraId!)),
    }
  })

  runXtokenstHorizontal('moonbeam transfer LDOT to acala', async () => {
    await moonbeamClient.dev.setStorage({
      Assets: {
        account: [[[moonbeam.custom.ldot, defaultAccounts.alith.address], { balance: 10e12 }]],
      },
    })

    return {
      fromChain: moonbeamClient,
      fromBalance: query.assets(moonbeam.custom.ldot),
      fromAccount: defaultAccounts.alith,

      toChain: acalaClient,
      toBalance: query.tokens(acala.custom.ldot),
      toAccount: defaultAccounts.bob,

      tx: tx.xtokens.transfer({ ForeignAsset: moonbeam.custom.ldot }, 1e12, tx.xtokens.parachainV3(acala.paraId!)),
    }
  })
})
