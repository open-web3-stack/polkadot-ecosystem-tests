import { describe } from 'vitest'

import { basilisk, karura, kusama } from '@e2e-test/networks/chains'
import { defaultAccounts } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('basilisk & karura', async () => {
  const [karuraClient, basiliskClient, kusamaClient] = await setupNetworks(karura, basilisk, kusama)

  runXtokenstHorizontal('karura transfer KSM to basilisk', async () => {
    return {
      fromChain: karuraClient,
      toChain: basiliskClient,
      routeChain: kusamaClient,
      isCheckUmp: true,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(karura.custom.ksm),
      toBalance: query.tokens(basilisk.custom.relayToken),
      tx: tx.xtokens.transfer(karura.custom.ksm, 10n ** 12n, tx.xtokens.parachainV4(basilisk.paraId!)),
    }
  })

  runXtokenstHorizontal('basilisk transfer KSM to karura', async () => {
    return {
      fromChain: basiliskClient,
      toChain: karuraClient,
      routeChain: kusamaClient,
      isCheckUmp: true,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(basilisk.custom.relayToken),
      toBalance: query.tokens(karura.custom.ksm),
      tx: tx.xtokens.transfer(basilisk.custom.relayToken, 10n ** 12n, tx.xtokens.parachainV4(karura.paraId!)),
    }
  }, { skip: true }) // TODO: somehow pjs is generate invalid signature

  runXtokenstHorizontal('basilisk transfer BSX to karura', async () => {
    return {
      fromChain: basiliskClient,
      toChain: karuraClient,
      fromBalance: query.balances,
      toBalance: query.tokens(karura.custom.bsx),
      tx: tx.xtokens.transfer(basilisk.custom.bsx, 10n ** 15n, tx.xtokens.parachainV4(karura.paraId!)),
    }
  }, { skip: true }) // TODO: somehow pjs is generate invalid signature

  runXtokenstHorizontal('karura transfer BSX to basilisk', async () => {
    await karuraClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccounts.alice.address, karura.custom.bsx], { free: 10n * 10n ** 15n }]],
      },
    })

    return {
      fromChain: karuraClient,
      toChain: basiliskClient,
      fromBalance: query.tokens(karura.custom.bsx),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(karura.custom.bsx, 10n ** 15n, tx.xtokens.parachainV4(basilisk.paraId!)),
    }
  })
})
