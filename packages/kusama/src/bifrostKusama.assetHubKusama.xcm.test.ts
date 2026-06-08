import { assetHubKusama, bifrostKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('bifrostKusama & assetHubKusama', async () => {
  const [assetHubKusamaClient, bifrostKusamaClient] = await setupNetworks(assetHubKusama, bifrostKusama)

  const bifrostKsm = bifrostKusama.custom.relayToken

  runXcmPalletHorizontal('assetHubKusama transfer KSM to bifrostKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: bifrostKusamaClient,
      fromBalance: query.balances,
      toBalance: query.tokens(bifrostKsm),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, bifrostKusama.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        'LocalReserve',
        { parents: 1, interior: 'Here' },
        'LocalReserve',
      ),
    }
  })

  runXcmPalletHorizontal('bifrostKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: bifrostKusamaClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.tokens(bifrostKsm),
      toBalance: query.balances,
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, assetHubKusama.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        'DestinationReserve',
        { parents: 1, interior: 'Here' },
        'DestinationReserve',
      ),
    }
  })
})
