import type { Client } from '@e2e-test/networks'
import { defaultAccounts } from '@e2e-test/networks'
import { acala, assetHubPolkadot, astar } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { beforeAll, describe } from 'vitest'

describe('acala & astar', () => {
  let astarClient: Client
  let acalaClient: Client
  let assetHubPolkadotClient: Client

  beforeAll(async () => {
    ;[astarClient, acalaClient, assetHubPolkadotClient] = await setupNetworks(astar, acala, assetHubPolkadot)
  })

  // Astar removed `xTokens` in runtime 2500, so its transfers go through the XCM pallet. Acala
  // keeps `xTokens`, so the transfers in the other direction use it.
  runXcmPalletHorizontal('astar transfer ACA to acala', async () => {
    return {
      fromChain: astarClient,
      toChain: acalaClient,
      fromBalance: query.assets(astar.custom.aca),
      toBalance: query.balances,
      // ACA's location, as Astar's `xcAssetConfig` records it. The XCM pallet takes locations,
      // while the assets pallet takes the numeric id.
      tx: tx.xcmPallet.transferAssetsV3(
        {
          Concrete: {
            parents: 1,
            interior: {
              X2: [
                { Parachain: acala.paraId! },
                {
                  GeneralKey: {
                    length: 2,
                    data: '0x0000000000000000000000000000000000000000000000000000000000000000',
                  },
                },
              ],
            },
          },
        },
        1e12,
        tx.xcmPallet.parachainV3(1, acala.paraId!),
      ),
    }
  })

  runXtokenstHorizontal('acala transfer ACA to astar', async () => {
    return {
      fromChain: acalaClient,
      toChain: astarClient,
      fromBalance: query.balances,
      toBalance: query.assets(astar.custom.aca),
      tx: tx.xtokens.transfer(acala.custom.aca, 1e12, tx.xtokens.parachainV3(astar.paraId!)),
    }
  })

  runXcmPalletHorizontal('astar transfer DOT to acala', async () => {
    return {
      fromChain: astarClient,
      toChain: acalaClient,
      routeChain: assetHubPolkadotClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.assets(astar.custom.dot),
      toBalance: query.tokens(acala.custom.dot),
      // DOT's reserve is neither Astar nor Acala, so the transfer names Polkadot Asset Hub as a
      // remote reserve. `transferAssets` does not accept a remote reserve.
      tx: tx.xcmPallet.transferAssetsUsingType(
        tx.xcmPallet.parachainV4(1, acala.paraId!),
        [{ id: { parents: 1, interior: 'Here' }, fun: { Fungible: 1e12 } }],
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubPolkadot.paraId }] } } } } as any,
        { parents: 1, interior: 'Here' },
        { RemoteReserve: { V4: { parents: 1, interior: { X1: [{ Parachain: assetHubPolkadot.paraId }] } } } } as any,
      ),
    }
  })

  runXtokenstHorizontal('acala transfer DOT to astar', async () => {
    return {
      fromChain: acalaClient,
      toChain: astarClient,
      routeChain: assetHubPolkadotClient,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(acala.custom.dot),
      toBalance: query.assets(astar.custom.dot),
      tx: tx.xtokens.transfer(acala.custom.dot, 1e12, tx.xtokens.parachainV3(astar.paraId!)),
    }
  })
})
