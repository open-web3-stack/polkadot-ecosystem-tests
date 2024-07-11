import { afterAll, beforeEach, describe } from 'vitest'

import { basilisk, karura, kusama } from '@e2e-test/networks/chains'
import { captureSnapshot, createNetworks } from '@e2e-test/networks'
import { defaultAccount } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'

describe('basilisk & karura', async () => {
  const [karuraClient, basiliskClient, kusamaClient] = await createNetworks(karura, basilisk, kusama)

  const restoreSnapshot = captureSnapshot(karuraClient, basiliskClient, kusamaClient)

  beforeEach(restoreSnapshot)

  afterAll(async () => {
    await karuraClient.teardown()
    await basiliskClient.teardown()
    await kusamaClient.teardown()
  })

  runXtokenstHorizontal('karura transfer KSM to basilisk', async () => {
    return {
      fromChain: karuraClient,
      toChain: basiliskClient,
      routeChain: kusamaClient,
      isCheckUmp: true,
      toAccount: defaultAccount.bob,
      fromBalance: query.tokens(karura.custom.ksm),
      toBalance: query.tokens(basilisk.custom.relayToken),
      tx: tx.xtokens.transfer(karura.custom.ksm, 10n ** 12n, tx.xtokens.parachainV4(basiliskClient.config.paraId!)),
    }
  })

  runXtokenstHorizontal('basilisk transfer KSM to karura', async () => {
    return {
      fromChain: basiliskClient,
      toChain: karuraClient,
      routeChain: kusamaClient,
      isCheckUmp: true,
      toAccount: defaultAccount.bob,
      fromBalance: query.tokens(basilisk.custom.relayToken),
      toBalance: query.tokens(karura.custom.ksm),
      tx: tx.xtokens.transfer(
        basilisk.custom.relayToken,
        10n ** 12n,
        tx.xtokens.parachainV4(karuraClient.config.paraId!),
      ),
    }
  })

  runXtokenstHorizontal('basilisk transfer BSX to karura', async () => {
    return {
      fromChain: basiliskClient,
      toChain: karuraClient,
      fromBalance: query.balances,
      toBalance: query.tokens(karura.custom.bsx),
      tx: tx.xtokens.transfer(basilisk.custom.bsx, 10n ** 15n, tx.xtokens.parachainV4(karuraClient.config.paraId!)),
    }
  })

  runXtokenstHorizontal('karura transfer BSX to basilisk', async () => {
    await karuraClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccount.alice.address, karura.custom.bsx], { free: 10n * 10n ** 15n }]],
      },
    })

    return {
      fromChain: karuraClient,
      toChain: basiliskClient,
      fromBalance: query.tokens(karura.custom.bsx),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(karura.custom.bsx, 10n ** 15n, tx.xtokens.parachainV4(basiliskClient.config.paraId!)),
    }
  })
})
