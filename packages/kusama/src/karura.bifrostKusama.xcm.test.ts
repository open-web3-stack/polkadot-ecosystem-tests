import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, bifrostKusama, karura } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('karura & bifrostKusama', async () => {
  const [karuraClient, bifrostKusamaClient, assetHubKusamaClient] = await setupNetworks(
    karura,
    bifrostKusama,
    assetHubKusama,
  )

  runXtokenstHorizontal('karura transfer KSM to bifrostKusama', async () => {
    return {
      fromChain: karuraClient,
      toChain: bifrostKusamaClient,
      routeChain: assetHubKusamaClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(karura.custom.ksm),
      toBalance: query.tokens(bifrostKusama.custom.relayToken),
      tx: tx.xtokens.transfer(karura.custom.ksm, 1e12, tx.xtokens.parachainV3(bifrostKusama.paraId!)),
    }
  })

  runXcmPalletHorizontal('bifrostKusama transfer KSM to karura', async () => {
    return {
      fromChain: bifrostKusamaClient,
      toChain: karuraClient,
      routeChain: assetHubKusamaClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(bifrostKusama.custom.relayToken),
      toBalance: query.tokens(karura.custom.ksm),
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, karura.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubKusama.paraId }] } } } } as any,
        { parents: 1, interior: 'Here' },
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubKusama.paraId }] } } } } as any,
      ),
    }
  })
})
