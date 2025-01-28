import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('polkadot & peoplePolkadot', async () => {
  const [polkadotClient, peopleClient] = await setupNetworks(polkadot, peoplePolkadot)

  const peopleDOT = peoplePolkadot.custom.dot
  const polkadotDOT = polkadot.custom.dot

  runXcmPalletDown('polkadot transfer DOT to peoplePolkadot', async () => {
    return {
      fromChain: polkadotClient,
      toChain: peopleClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.teleportAssetsV3(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(0, peoplePolkadot.paraId!)),
    }
  })

  runXcmPalletUp('peoplePolkadot transfer DOT to polkadot', async () => {
    return {
      fromChain: peopleClient,
      toChain: polkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.teleportAssetsV3(peopleDOT, 1e12, tx.xcmPallet.relaychainV4),
    }
  })
})
