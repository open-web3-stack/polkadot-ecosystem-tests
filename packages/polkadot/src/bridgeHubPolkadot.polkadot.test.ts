import { defaultAccounts } from '@e2e-test/networks'
import { bridgeHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('polkadot & bridgeHubPolkadot', async () => {
  const [polkadotClient, bridgeHubClient] = await setupNetworks(polkadot, bridgeHubPolkadot)

  const bridgeHubDOT = bridgeHubPolkadot.custom.dot
  const polkadotDOT = polkadot.custom.dot

  runXcmPalletDown(
    'polkadot transfer DOT to bridgeHubPolkadot',
    async () => {
      return {
        fromChain: polkadotClient,
        toChain: bridgeHubClient,
        balance: query.balances,
        toAccount: defaultAccounts.dave,
        tx: tx.xcmPallet.teleportAssetsV3(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(0, bridgeHubPolkadot.paraId!)),
        totalIssuanceProvider: () => query.totalIssuance(polkadotClient),
      }
    },
    { skip: true },
  )

  runXcmPalletUp(
    'bridgeHubPolkadot transfer DOT to polkadot',
    async () => {
      return {
        fromChain: bridgeHubClient,
        toChain: polkadotClient,
        balance: query.balances,
        toAccount: defaultAccounts.dave,
        tx: tx.xcmPallet.teleportAssetsV3(bridgeHubDOT, 1e12, tx.xcmPallet.relaychainV4),
        totalIssuanceProvider: () => query.totalIssuance(polkadotClient),
      }
    },
    { skip: true },
  )
})
