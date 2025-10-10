import { karura, kusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXtokensUp } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('karura & kusama', async () => {
  const [karuraClient, kusamaClient] = await setupNetworks(karura, kusama)

  const karuraKSM = karura.custom.ksm
  const kusamaKSM = kusama.custom.ksm

  runXtokensUp(
    'karura transfer KSM to kusama',
    async () => {
      return {
        fromChain: karuraClient,
        toChain: kusamaClient,
        balance: query.tokens(karuraKSM),
        tx: tx.xtokens.transfer(karuraKSM, 1e12, tx.xtokens.relaychainV3),
      }
    },
    { skip: true },
  )

  runXtokensUp(
    'karura transfer KSM to kusama wiht limited weight',
    async () => {
      return {
        fromChain: karuraClient,
        toChain: kusamaClient,
        balance: query.tokens(karuraKSM),
        tx: tx.xtokens.transfer(karuraKSM, 1e12, tx.xtokens.relaychainV3, {
          Limited: { refTime: 500000000, proofSize: 10000 },
        }),
      }
    },
    { skip: true },
  )

  runXcmPalletDown(
    'kusama transfer KSM to karura',
    async () => {
      return {
        fromChain: kusamaClient,
        toChain: karuraClient,
        balance: query.tokens(karuraKSM),
        tx: tx.xcmPallet.limitedReserveTransferAssetsV3(kusamaKSM, 1e12, tx.xcmPallet.parachainV3(0, karura.paraId!)),
      }
    },
    { skip: true },
  )
})
