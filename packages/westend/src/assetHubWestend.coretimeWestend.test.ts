import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubWestend, coretimeWestend } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('assetHubWestend & coretimeWestend', async () => {
  const [assetHubWestendClient, coretimeClient] = await setupNetworks(assetHubWestend, coretimeWestend)

  const coretimeWND = coretimeWestend.custom.wnd
  const westendWND = assetHubWestend.custom.wnd

  runXcmPalletDown('assetHubWestend transfer WND to coretimeWestend', async () => {
    return {
      fromChain: assetHubWestendClient,
      toChain: coretimeClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        westendWND,
        100 * assetHubWestend.custom.units,
        tx.xcmPallet.parachainV3(1, coretimeWestend.paraId!),
      ),
    }
  })

  runXcmPalletUp('coretimeWestend transfer WND to assetHubWestend', async () => {
    return {
      fromChain: coretimeClient,
      toChain: assetHubWestendClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        coretimeWND,
        100 * coretimeWestend.custom.units,
        tx.xcmPallet.parachainV3(1, assetHubWestendClient.config.paraId!),
      ),
    }
  })
})
