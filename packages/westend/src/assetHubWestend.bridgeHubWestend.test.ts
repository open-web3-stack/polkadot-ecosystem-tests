import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubWestend, bridgeHubWestend } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('assetHubWestend & bridgeHubWestend', async () => {
  const [assetHubWestendClient, bridgeHubClient] = await setupNetworks(assetHubWestend, bridgeHubWestend)

  const bridgeHubWND = bridgeHubWestend.custom.wnd
  const westendWND = assetHubWestend.custom.wnd

  runXcmPalletDown('assetHubWestend transfer WND to bridgeHubWestend', async () => {
    return {
      fromChain: assetHubWestendClient,
      toChain: bridgeHubClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(westendWND, 1e12, tx.xcmPallet.parachainV3(1, bridgeHubWestend.paraId!)),
    }
  })

  runXcmPalletUp('bridgeHubWestend transfer WND to assetHubWestend', async () => {
    return {
      fromChain: bridgeHubClient,
      toChain: assetHubWestendClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        bridgeHubWND,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubWestendClient.config.paraId!),
      ),
    }
  })
})
