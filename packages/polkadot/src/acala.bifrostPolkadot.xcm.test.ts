import { defaultAccounts } from '@e2e-test/networks'
import { acala, assetHubPolkadot, bifrostPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('acala & bifrostPolkadot', async () => {
  const [acalaClient, bifrostPolkadotClient, assetHubPolkadotClient] = await setupNetworks(
    acala,
    bifrostPolkadot,
    assetHubPolkadot,
  )

  runXtokenstHorizontal('acala transfer DOT to bifrostPolkadot', async () => {
    return {
      fromChain: acalaClient,
      toChain: bifrostPolkadotClient,
      routeChain: assetHubPolkadotClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(acala.custom.dot),
      toBalance: query.tokens(bifrostPolkadot.custom.relayToken),
      tx: tx.xtokens.transfer(acala.custom.dot, 1e12, tx.xtokens.parachainV3(bifrostPolkadot.paraId!)),
    }
  })

  runXcmPalletHorizontal('bifrostPolkadot transfer DOT to acala', async () => {
    return {
      fromChain: bifrostPolkadotClient,
      toChain: acalaClient,
      routeChain: assetHubPolkadotClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(bifrostPolkadot.custom.relayToken),
      toBalance: query.tokens(acala.custom.dot),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, acala.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubPolkadot.paraId }] } } } } as any,
        { parents: 1, interior: 'Here' },
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubPolkadot.paraId }] } } } } as any,
      ),
    }
  })
})
