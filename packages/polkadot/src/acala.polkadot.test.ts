import { afterAll, beforeEach, describe } from 'vitest'

import { acala, polkadot } from '@e2e-test/networks/chains'
import { captureSnapshot, createNetworks } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

describe('acala & polkadot', async () => {
  const [polkadotClient, acalaClient] = await createNetworks(polkadot, acala)

  const restoreSnapshot = captureSnapshot(polkadotClient, acalaClient)

  beforeEach(restoreSnapshot)

  const acalaDOT = acalaClient.config.custom.dot
  const polkadotDOT = polkadotClient.config.custom.dot

  afterAll(async () => {
    await polkadotClient.teardown()
    await acalaClient.teardown()
  })

  runXtokensUp('acala transfer DOT to polkadot', async () => {
    return {
      fromChain: acalaClient,
      toChain: polkadotClient,
      balance: query.tokens(acalaDOT),
      tx: tx.xtokens.transfer(acalaDOT, 1e12, tx.xtokens.relaychainV3),
    }
  })

  runXtokensUp('acala transfer DOT wiht limited weight', async () => {
    return {
      fromChain: acalaClient,
      toChain: polkadotClient,
      balance: query.tokens(acalaDOT),
      tx: tx.xtokens.transfer(acalaDOT, 1e12, tx.xtokens.relaychainV3, {
        Limited: { refTime: 5000000000, proofSize: 10000 },
      }),
    }
  })

  runXcmPalletDown('polkadot transfer DOT to acala', async () => {
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
