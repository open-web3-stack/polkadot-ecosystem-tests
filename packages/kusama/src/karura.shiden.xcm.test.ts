import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, karura, shiden } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('karura & shiden', async () => {
  const [shidenClient, karuraClient, assetHubKusamaClient] = await setupNetworks(shiden, karura, assetHubKusama)

  // Shiden removed `xTokens`, so its transfers go through the XCM pallet. Karura keeps
  // `xTokens`, so the transfers in the other direction are unchanged.
  runXcmPalletHorizontal('shiden transfer KAR to karura', async () => {
    return {
      fromChain: shidenClient,
      toChain: karuraClient,
      fromBalance: query.assets(shiden.custom.kar),
      toBalance: query.balances,
      tx: tx.xcmPallet.transferAssetsV3(shiden.custom.xcmKar, 1e12, tx.xcmPallet.parachainV3(1, karura.paraId!)),
    }
  })

  runXtokenstHorizontal('karura transfer KAR to shiden', async () => {
    return {
      fromChain: karuraClient,
      toChain: shidenClient,
      fromBalance: query.balances,
      toBalance: query.assets(shiden.custom.kar),
      tx: tx.xtokens.transfer(karura.custom.kar, 1e12, tx.xtokens.parachainV3(shiden.paraId!)),
    }
  })

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
