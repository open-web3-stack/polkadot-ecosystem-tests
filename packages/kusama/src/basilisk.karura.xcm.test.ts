import { defaultAccounts, defaultAccountsSr25519 } from '@e2e-test/networks'
import { assetHubKusama, basilisk, karura } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('basilisk & karura', async () => {
  const [karuraClient, basiliskClient, assetHubKusamaClient] = await setupNetworks(karura, basilisk, assetHubKusama)

  runXtokenstHorizontal('karura transfer KSM to basilisk', async () => {
    return {
      fromChain: karuraClient,
      toChain: basiliskClient,
      routeChain: assetHubKusamaClient,
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
      routeChain: assetHubKusamaClient,
      fromAccount: defaultAccountsSr25519.alice,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(basilisk.custom.relayToken),
      toBalance: query.tokens(karura.custom.ksm),
      tx: tx.xtokens.transfer(basilisk.custom.relayToken, 10n ** 12n, tx.xtokens.parachainV4(karura.paraId!)),
    }
  })

  runXtokenstHorizontal('basilisk transfer BSX to karura', async () => {
    return {
      fromChain: basiliskClient,
      toChain: karuraClient,
      fromAccount: defaultAccountsSr25519.alice,
      fromBalance: query.balances,
      toBalance: query.tokens(karura.custom.bsx),
      tx: tx.xtokens.transfer(basilisk.custom.bsx, 10n ** 15n, tx.xtokens.parachainV4(karura.paraId!)),
    }
  })

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
