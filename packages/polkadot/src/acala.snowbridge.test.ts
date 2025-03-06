import { describe } from 'vitest'

import { acala, assetHubPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown } from '@e2e-test/shared/xcm'

describe('acala & snowbridge', async () => {
  const [ahClient, acalaClient] = await setupNetworks(assetHubPolkadot, acala)

  const acalaDOT = acalaClient.config.custom.dot
  const acalaWETH = acalaClient.config.custom.weth
  const ahDOT = ahClient.config.custom.dot
  const ahWETH = ahClient.config.custom.weth

  runXcmPalletDown('snowbridge transfer WETH from asset hub to acala', async () => {
    return {
      fromChain: ahClient,
      toChain: acalaClient,
      balance: query.tokens(acalaWETH),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV3(0, acalaClient.config.paraId!),
        [
          { id: ahDOT, fun: { Fungible: 1e10 } },
          { id: ahWETH, fun: { Fungible: 1e18 } },
        ],
        'LocalReserve',
        ahDOT,
        'LocalReserve',
      ),
    }
  })

  runXcmPalletDown('snowbridge transfer WETH from acala to asset hub', async () => {
    return {
      fromChain: acalaClient,
      toChain: ahClient,
      balance: query.tokens(ahWETH),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV3(0, acalaClient.config.paraId!),
        [
          { id: acalaDOT, fun: { Fungible: 1e10 } },
          { id: acalaWETH, fun: { Fungible: 1e18 } },
        ],
        'DestinationReserve',
        acalaDOT,
        'DestinationReserve',
      ),
    }
  })
})
