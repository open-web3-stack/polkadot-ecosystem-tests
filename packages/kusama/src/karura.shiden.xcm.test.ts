import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, karura, shiden } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('karura & shiden', async () => {
  const [shidenClient, karuraClient, assetHubKusamaClient] = await setupNetworks(shiden, karura, assetHubKusama)

  // Shiden and Karura have no HRMP channel between them, so KAR cannot move directly in either
  // direction. Both chains keep a channel to Kusama Asset Hub, so KSM still moves between them
  // with the Asset Hub as its reserve.
  //
  // Shiden removed `xTokens`, so its transfers go through the XCM pallet. Karura keeps `xTokens`,
  // so the transfers in the other direction use it.
  runXcmPalletHorizontal('shiden transfer KSM to karura', async () => {
    return {
      fromChain: shidenClient,
      toChain: karuraClient,
      routeChain: assetHubKusamaClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.assets(shiden.custom.ksm),
      toBalance: query.tokens(karura.custom.ksm),
      // KSM's reserve is neither Shiden nor Karura, so the transfer names Kusama Asset Hub as a
      // remote reserve. `transferAssets` does not accept a remote reserve.
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, karura.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubKusama.paraId }] } } } } as any,
        { parents: 1, interior: 'Here' },
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubKusama.paraId }] } } } } as any,
      ),
    }
  })

  runXtokenstHorizontal('karura transfer KSM to shiden', async () => {
    return {
      fromChain: karuraClient,
      toChain: shidenClient,
      routeChain: assetHubKusamaClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(karura.custom.ksm),
      toBalance: query.assets(shiden.custom.ksm),
      tx: tx.xtokens.transfer(karura.custom.ksm, 1e12, tx.xtokens.parachainV3(shiden.paraId!)),
    }
  })
})
