import { afterAll, describe } from 'vitest'
import { connectParachains, connectVertical } from '@acala-network/chopsticks'

import { astar, polkadot } from '@e2e-test/networks/chains'
import { createNetwork } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown } from '@e2e-test/shared/xcm'

describe(`'polkadot' <-> 'astar' xcm transfer`, async () => {
  const [polkadotClient, astarClient] = await Promise.all([createNetwork(polkadot), createNetwork(astar)])

  await connectVertical(polkadotClient.chain, astarClient.chain)
  await connectParachains([astarClient.chain])

  const astarDOT = astarClient.config.custom!.dot
  const polkadotDOT = polkadotClient.config.custom!.dot

  afterAll(async () => {
    console.log('afterAll')
    await polkadotClient.teardown()
    await astarClient.teardown()
  })

  runXcmPalletDown(`'polkadot' -> 'astar' DOT`, async () => {
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
})
