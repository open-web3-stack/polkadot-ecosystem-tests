import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubWestend, peopleWestend } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('assetHubWestend & peopleWestend', async () => {
  const [assetHubWestendClient, peopleClient] = await setupNetworks(assetHubWestend, peopleWestend)

  const peopleWND = peopleWestend.custom.wnd
  const westendWND = assetHubWestend.custom.wnd

  runXcmPalletDown('assetHubWestend transfer WND to peopleWestend', async () => {
    return {
      fromChain: assetHubWestendClient,
      toChain: peopleClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(westendWND, 1e12, tx.xcmPallet.parachainV3(1, peopleWestend.paraId!)),
    }
  })

  runXcmPalletUp('peopleWestend transfer WND to assetHubWestend', async () => {
    return {
      fromChain: peopleClient,
      toChain: assetHubWestendClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        peopleWND,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubWestendClient.config.paraId!),
      ),
    }
  })
})
