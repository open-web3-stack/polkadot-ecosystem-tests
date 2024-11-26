import { describe } from 'vitest'

import { karura, shiden } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('karura & shiden', async () => {
  const [shidenClient, karuraClient] = await setupNetworks(shiden, karura)

  runXtokenstHorizontal('shiden transfer KAR to karura', async () => {
    return {
      fromChain: shidenClient,
      toChain: karuraClient,
      fromBalance: query.assets(shiden.custom.kar),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(
        shiden.custom.kar,
        1e12,
        tx.xtokens.parachainV3(karura.paraId!),
      ),
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
})
