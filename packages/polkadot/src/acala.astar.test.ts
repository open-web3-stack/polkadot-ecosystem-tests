import { describe } from 'vitest'

import { acala, astar } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('acala & astar', async () => {
  const [astarClient, acalaClient] = await setupNetworks(astar, acala)

  runXtokenstHorizontal('astar transfer ACA to acala', async () => {
    return {
      fromChain: astarClient,
      toChain: acalaClient,
      fromBalance: query.assets(astar.custom.aca),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(
        astar.custom.aca,
        1e12,
        tx.xtokens.parachainV3(acala.paraId!),
      ),
    }
  })

  runXtokenstHorizontal('acala transfer ACA to astar', async () => {
    return {
      fromChain: acalaClient,
      toChain: astarClient,
      fromBalance: query.balances,
      toBalance: query.assets(astar.custom.aca),
      tx: tx.xtokens.transfer(acala.custom.aca, 1e12, tx.xtokens.parachainV3(astar.paraId!)),
    }
  })
})
