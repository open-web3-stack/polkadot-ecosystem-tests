import { afterAll, describe } from 'vitest'
import { connectParachains, connectVertical } from '@acala-network/chopsticks'

import { acala, polkadot } from '@e2e-test/networks/chains'
import { createNetwork } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

describe(`'acala' <-> 'polkadt' xcm transfer`, async () => {
  const [polkadotClient, acalaClient] = await Promise.all([createNetwork(polkadot), createNetwork(acala)])

  await connectVertical(polkadotClient.chain, acalaClient.chain)
  await connectParachains([acalaClient.chain])

  const acalaDOT = acalaClient.config.custom!.dot
  const polkadotDOT = polkadotClient.config.custom!.dot

  afterAll(async () => {
    console.log('afterAll')
    await polkadotClient.teardown()
    await acalaClient.teardown()
  })

  runXtokensUp(`'acala' -> 'polkadot' DOT`, async () => {
    return {
      fromChain: acalaClient,
      toChain: polkadotClient,
      balance: query.tokens(acalaDOT),
      tx: tx.xtokens.transfer(acalaDOT, 1e12, tx.xtokens.relaychainV3),
    }
  })

  runXtokensUp(`'acala' -> 'polkadot' DOT wiht limited weight`, async () => {
    return {
      fromChain: acalaClient,
      toChain: polkadotClient,
      balance: query.tokens(acalaDOT),
      tx: tx.xtokens.transfer(acalaDOT, 1e12, tx.xtokens.relaychainV3, { Limited: { refTime: 5000000000 } }),
    }
  })

  runXcmPalletDown(`'polkadot' -> 'acala' DOT`, async () => {
    return {
      fromChain: polkadotClient,
      toChain: acalaClient,
      balance: query.tokens(acalaDOT),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        polkadotDOT,
        1e12,
        tx.xcmPallet.parachainV3(0, acalaClient.config.paraId!),
      ),
    }
  })
})
