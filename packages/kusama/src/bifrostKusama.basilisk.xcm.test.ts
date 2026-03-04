import { defaultAccounts, defaultAccountsSr25519 } from '@e2e-test/networks'
import { assetHubKusama, basilisk, bifrostKusama } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('bifrostKusama & basilisk', async () => {
  const [bifrostKusamaClient, basiliskClient, assetHubKusamaClient] = await setupNetworks(
    bifrostKusama,
    basilisk,
    assetHubKusama,
  )

  runXcmPalletHorizontal('bifrostKusama transfer KSM to basilisk', async () => {
    return {
      fromChain: bifrostKusamaClient,
      toChain: basiliskClient,
      routeChain: assetHubKusamaClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(bifrostKusama.custom.relayToken),
      toBalance: query.tokens(basilisk.custom.relayToken),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, basilisk.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubKusama.paraId }] } } } } as any,
        { parents: 1, interior: 'Here' },
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubKusama.paraId }] } } } } as any,
      ),
    }
  })

  runXtokenstHorizontal('basilisk transfer KSM to bifrostKusama', async () => {
    return {
      fromChain: basiliskClient,
      toChain: bifrostKusamaClient,
      routeChain: assetHubKusamaClient,
      fromAccount: defaultAccountsSr25519.alice,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(basilisk.custom.relayToken),
      toBalance: query.tokens(bifrostKusama.custom.relayToken),
      tx: tx.xtokens.transfer(basilisk.custom.relayToken, 1e12, tx.xtokens.parachainV3(bifrostKusama.paraId!)),
    }
  })
})
