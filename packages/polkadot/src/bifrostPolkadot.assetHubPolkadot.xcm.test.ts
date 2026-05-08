import { assetHubPolkadot, bifrostPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('bifrostPolkadot & assetHubPolkadot', async () => {
  const [assetHubPolkadotClient, bifrostPolkadotClient] = await setupNetworks(assetHubPolkadot, bifrostPolkadot)

  const bifrostDot = bifrostPolkadot.custom.relayToken
  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to bifrostPolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: bifrostPolkadotClient,
      fromBalance: query.balances,
      toBalance: query.tokens(bifrostDot),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, bifrostPolkadot.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        'LocalReserve',
        { parents: 1, interior: 'Here' },
        'LocalReserve',
      ),
    }
  })

  runXcmPalletHorizontal('bifrostPolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: bifrostPolkadotClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.tokens(bifrostDot),
      toBalance: query.balances,
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, assetHubPolkadot.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        'DestinationReserve',
        { parents: 1, interior: 'Here' },
        'DestinationReserve',
      ),
    }
  })
})
