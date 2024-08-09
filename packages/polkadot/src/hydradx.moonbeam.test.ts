import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { hydraDX, moonbeam, polkadot } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('hydraDX & moonbeam', async () => {
  const [hydraDXClient, moonbeamClient, polkadotClient] = await setupNetworks(hydraDX, moonbeam, polkadot)

  const hydraDXDot = hydraDX.custom.relayToken
  const moonbeamDot = moonbeam.custom.dot
  const glmr = hydraDX.custom.glmr

  runXtokenstHorizontal('hydraDX transfer DOT to moonbeam', async () => {
    return {
      fromChain: hydraDXClient,
      fromBalance: query.tokens(hydraDXDot),
      fromAccount: defaultAccounts.alice,

      toChain: moonbeamClient,
      toBalance: query.assets(moonbeamDot),
      toAccount: defaultAccounts.alith,

      routeChain: polkadotClient,
      isCheckUmp: true,

      tx: tx.xtokens.transfer(hydraDXDot, 1e12, tx.xtokens.parachainAccountId20V3(moonbeam.paraId!)),
    }
  })

  runXtokenstHorizontal('moonbeam transfer DOT to hydraDX', async () => {
    await moonbeamClient.dev.setStorage({
      Assets: {
        account: [[[moonbeamDot, defaultAccounts.alith.address], { balance: 10e12 }]],
      },
    })

    return {
      fromChain: moonbeamClient,
      fromBalance: query.assets(moonbeamDot),
      fromAccount: defaultAccounts.alith,

      toChain: hydraDXClient,
      toBalance: query.tokens(hydraDXDot),
      toAccount: defaultAccounts.alice,

      routeChain: polkadotClient,
      isCheckUmp: true,

      tx: tx.xtokens.transfer({ ForeignAsset: moonbeamDot }, 1e12, tx.xtokens.parachainV3(hydraDX.paraId!)),
    }
  })

  runXtokenstHorizontal('hydraDX transfer GLMR to moonbeam', async () => {
    await hydraDXClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccounts.alice.address, glmr], { free: 10e12 }]],
      },
    })

    return {
      fromChain: hydraDXClient,
      fromBalance: query.tokens(glmr),
      fromAccount: defaultAccounts.alice,

      toChain: moonbeamClient,
      toBalance: query.balances,
      toAccount: defaultAccounts.baltathar,

      tx: tx.xtokens.transfer(glmr, 1e12, tx.xtokens.parachainAccountId20V3(moonbeam.paraId!)),
    }
  })
})
