import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, peoplePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubPolkadot & peoplePolkadot', async () => {
  const [assetHubPolkadotClient, peopleClient] = await setupNetworks(assetHubPolkadot, peoplePolkadot)

  const peopleDOT = peoplePolkadot.custom.dot
  const polkadotDOT = assetHubPolkadot.custom.dot

  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to peoplePolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: peopleClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(1, peoplePolkadot.paraId!)),
    }
  })

  runXcmPalletHorizontal(
    'peoplePolkadot transfer DOT to assetHubPolkadot',
    async () => {
      return {
        fromChain: peopleClient,
        toChain: assetHubPolkadotClient,
        fromBalance: query.balances,
        toBalance: query.balances,
        toAccount: defaultAccounts.dave,
        tx: tx.xcmPallet.limitedTeleportAssets(
          peopleDOT,
          1e12,
          tx.xcmPallet.parachainV3(1, assetHubPolkadotClient.config.paraId!),
        ),
      }
    },
    { skip: true },
  )
})
