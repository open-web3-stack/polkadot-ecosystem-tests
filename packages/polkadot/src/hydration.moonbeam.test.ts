import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { hydration, moonbeam, polkadot } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('hydration & moonbeam', async () => {
  const [hydrationClient, moonbeamClient, polkadotClient] = await setupNetworks(hydration, moonbeam, polkadot)

  const hydrationDot = hydration.custom.relayToken
  const moonbeamDot = moonbeam.custom.dot
  const glmr = hydration.custom.glmr

  runXtokenstHorizontal('hydration transfer DOT to moonbeam', async () => {
    return {
      fromChain: hydrationClient,
      fromBalance: query.tokens(hydrationDot),
      fromAccount: defaultAccounts.alice,

      toChain: moonbeamClient,
      toBalance: query.assets(moonbeamDot),
      toAccount: defaultAccounts.alith,

      routeChain: polkadotClient,
      isCheckUmp: true,

      tx: tx.xtokens.transfer(hydrationDot, 1e12, tx.xtokens.parachainAccountId20V3(moonbeam.paraId!)),
    }
  })

  runXtokenstHorizontal('moonbeam transfer DOT to hydration', async () => {
    await moonbeamClient.dev.setStorage({
      Assets: {
        account: [[[moonbeamDot, defaultAccounts.alith.address], { balance: 10e12 }]],
      },
    })

    return {
      fromChain: moonbeamClient,
      fromBalance: query.assets(moonbeamDot),
      fromAccount: defaultAccounts.alith,

      toChain: hydrationClient,
      toBalance: query.tokens(hydrationDot),
      toAccount: defaultAccounts.alice,

      routeChain: polkadotClient,
      isCheckUmp: true,

      tx: tx.xtokens.transfer({ ForeignAsset: moonbeamDot }, 1e12, tx.xtokens.parachainV3(hydration.paraId!)),
    }
  })

  runXtokenstHorizontal('hydration transfer GLMR to moonbeam', async () => {
    await hydrationClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccounts.alice.address, glmr], { free: 10e12 }]],
      },
    })

    return {
      fromChain: hydrationClient,
      fromBalance: query.tokens(glmr),
      fromAccount: defaultAccounts.alice,

      toChain: moonbeamClient,
      toBalance: query.balances,
      toAccount: defaultAccounts.baltathar,

      tx: tx.xtokens.transfer(glmr, 1e12, tx.xtokens.parachainAccountId20V3(moonbeam.paraId!)),
    }
  })
})
