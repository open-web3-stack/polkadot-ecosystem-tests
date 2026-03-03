import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, karura, shiden } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('karura & shiden', async () => {
  const [shidenClient, karuraClient, assetHubKusamaClient] = await setupNetworks(shiden, karura, assetHubKusama)

  runXtokenstHorizontal('shiden transfer KAR to karura', async () => {
    return {
      fromChain: shidenClient,
      toChain: karuraClient,
      fromBalance: query.assets(shiden.custom.kar),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(shiden.custom.kar, 1e12, tx.xtokens.parachainV3(karura.paraId!)),
    }
  })

  runXtokenstHorizontal('karura transfer KAR to shiden', async () => {
    return {
      fromChain: karuraClient,
      toChain: shidenClient,
      fromBalance: query.balances,
      toBalance: query.assets(shiden.custom.kar),
      tx: tx.xtokens.transfer(karura.custom.kar, 1e12, tx.xtokens.parachainV3(shiden.paraId!)),
    }
  })

  runXtokenstHorizontal('shiden transfer KSM to karura', async () => {
    return {
      fromChain: shidenClient,
      toChain: karuraClient,
      routeChain: assetHubKusamaClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.assets(shiden.custom.ksm),
      toBalance: query.tokens(karura.custom.ksm),
      tx: tx.xtokens.transfer(shiden.custom.ksm, 1e12, tx.xtokens.parachainV3(karura.paraId!)),
    }
  })

  runXtokenstHorizontal('karura transfer KSM to shiden', async () => {
    return {
      fromChain: karuraClient,
      toChain: shidenClient,
      routeChain: assetHubKusamaClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(karura.custom.ksm),
      toBalance: query.assets(shiden.custom.ksm),
      tx: tx.xtokens.transfer(karura.custom.ksm, 1e12, tx.xtokens.parachainV3(shiden.paraId!)),
    }
  })
})
