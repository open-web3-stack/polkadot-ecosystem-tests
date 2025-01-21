import { describe } from 'vitest'

import { astar, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

describe('astar & polkadot', async () => {
  const [polkadotClient, astarClient] = await setupNetworks(polkadot, astar)

  const astarDOT = astarClient.config.custom!.dot
  const polkadotDOT = polkadotClient.config.custom!.dot

  runXcmPalletDown('polkadot transfer DOT to astar', async () => {
    return {
      fromChain: polkadotClient,
      toChain: astarClient,
      balance: query.assets(astarDOT),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        polkadotDOT,
        1e12,
        tx.xcmPallet.parachainV3(0, astarClient.config.paraId!),
      ),
    }
  })

  runXtokensUp('astar transfer DOT to polkadot', async () => {
    return {
      fromChain: astarClient,
      toChain: polkadotClient,
      balance: query.assets(astarDOT),
      tx: tx.xtokens.transfer(astarDOT, 1e12, tx.xtokens.relaychainV3),
    }
  })
})
