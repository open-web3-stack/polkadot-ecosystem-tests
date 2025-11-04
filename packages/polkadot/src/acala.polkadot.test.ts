import { acala, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('acala & polkadot', async () => {
  const [polkadotClient, acalaClient] = await setupNetworks(polkadot, acala)

  const acalaDOT = acalaClient.config.custom.dot
  const polkadotDOT = polkadotClient.config.custom.dot

  runXtokensUp(
    'acala transfer DOT to polkadot',
    async () => {
      return {
        fromChain: acalaClient,
        toChain: polkadotClient,
        balance: query.tokens(acalaDOT),
        tx: tx.xtokens.transfer(acalaDOT, 1e12, tx.xtokens.relaychainV3),
      }
    },
    { skip: true },
  )

  runXtokensUp(
    'acala transfer DOT with limited weight',
    async () => {
      return {
        fromChain: acalaClient,
        toChain: polkadotClient,
        balance: query.tokens(acalaDOT),
        tx: tx.xtokens.transfer(acalaDOT, 1e12, tx.xtokens.relaychainV3, {
          Limited: { refTime: 5000000000, proofSize: 10000 },
        }),
      }
    },
    { skip: true },
  )

  runXcmPalletDown(
    'polkadot transfer DOT to acala',
    async () => {
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
    },
    { skip: true },
  )
})
