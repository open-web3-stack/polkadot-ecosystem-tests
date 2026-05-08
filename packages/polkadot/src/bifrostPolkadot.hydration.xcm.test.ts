import { defaultAccounts, defaultAccountsSr25519 } from '@e2e-test/networks'
import { assetHubPolkadot, bifrostPolkadot, hydration } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('bifrostPolkadot & hydration', async () => {
  const [bifrostPolkadotClient, hydrationClient, assetHubPolkadotClient] = await setupNetworks(
    bifrostPolkadot,
    hydration,
    assetHubPolkadot,
  )

  runXcmPalletHorizontal('bifrostPolkadot transfer DOT to hydration', async () => {
    return {
      fromChain: bifrostPolkadotClient,
      toChain: hydrationClient,
      routeChain: assetHubPolkadotClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(bifrostPolkadot.custom.relayToken),
      toBalance: query.tokens(hydration.custom.relayToken),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, hydration.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubPolkadot.paraId }] } } } } as any,
        { parents: 1, interior: 'Here' },
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubPolkadot.paraId }] } } } } as any,
      ),
    }
  })

  runXtokenstHorizontal('hydration transfer DOT to bifrostPolkadot', async () => {
    return {
      fromChain: hydrationClient,
      toChain: bifrostPolkadotClient,
      routeChain: assetHubPolkadotClient,
      fromAccount: defaultAccountsSr25519.alice,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(hydration.custom.relayToken),
      toBalance: query.tokens(bifrostPolkadot.custom.relayToken),
      tx: tx.xtokens.transfer(hydration.custom.relayToken, 1e12, tx.xtokens.parachainV3(bifrostPolkadot.paraId!)),
    }
  })
})
