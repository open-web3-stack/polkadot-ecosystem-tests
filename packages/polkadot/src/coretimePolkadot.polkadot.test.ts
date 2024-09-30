import { describe } from 'vitest'

import { coretimePolkadot, polkadot } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('polkadot & coretimePolkadot', async () => {
  const [polkadotClient, coretimeClient] = await setupNetworks(polkadot, coretimePolkadot)

  const coretimeDOT = coretimePolkadot.custom.dot
  const polkadotDOT = polkadot.custom.dot

  runXcmPalletDown('polkadot transfer DOT to coretimePolkadot', async () => {
    return {
      fromChain: polkadotClient,
      toChain: coretimeClient,
      balance: query.balances,
      tx: tx.xcmPallet.teleportAssetsV3(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(0, coretimePolkadot.paraId!)),
    }
  })

  runXcmPalletUp('coretimePolkadot transfer DOT to polkadot', async () => {
    return {
      fromChain: coretimeClient,
      toChain: polkadotClient,
      balance: query.balances,
      tx: tx.xcmPallet.teleportAssetsV3(coretimeDOT, 1e12, tx.xcmPallet.relaychainV4),
    }
  })
})
