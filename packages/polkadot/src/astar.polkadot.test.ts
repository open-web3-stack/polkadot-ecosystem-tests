import { afterAll, beforeEach, describe } from 'vitest'

import { astar, polkadot } from '@e2e-test/networks/chains'
import { captureSnapshot, createNetworks } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

describe('astar & polkadot', async () => {
  const [polkadotClient, astarClient] = await createNetworks(polkadot, astar)

  const restoreSnapshot = captureSnapshot(polkadotClient, astarClient)

  beforeEach(restoreSnapshot)

  const astarDOT = astarClient.config.custom!.dot
  const polkadotDOT = polkadotClient.config.custom!.dot

  afterAll(async () => {
    await polkadotClient.teardown()
    await astarClient.teardown()
  })

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

  runXtokensUp('polkadot transfer DOT to astar', async () => {
    return {
      fromChain: polkadotClient,
      toChain: astarClient,
      balance: query.tokens(polkadotDOT),
      tx: tx.xtokens.transfer(polkadotDOT, 1e12, tx.xtokens.relaychainV3),
    }
  })
})
