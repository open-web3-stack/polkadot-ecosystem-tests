import { assetHubPolkadot, astar } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('astar & assetHubPolkadot', async () => {
  const [assetHubPolkadotClient, astarClient] = await setupNetworks(assetHubPolkadot, astar)

  const astarDOT = astar.custom.dot
  const assetHubDOT = assetHubPolkadot.custom.dot

  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to astar', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: astarClient,
      fromBalance: query.balances,
      toBalance: query.assets(astarDOT),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(assetHubDOT, 1e12, tx.xcmPallet.parachainV3(1, astar.paraId!)),
    }
  })

  runXtokenstHorizontal('astar transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: astarClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.assets(astarDOT),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(astarDOT, 1e12, tx.xtokens.parachainV4(assetHubPolkadot.paraId!)),
    }
  })
})
