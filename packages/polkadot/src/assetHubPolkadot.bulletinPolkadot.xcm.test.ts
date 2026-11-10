import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, bulletinPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubPolkadot & bulletinPolkadot', async () => {
  const [assetHubPolkadotClient, bulletinPolkadotClient] = await setupNetworks(assetHubPolkadot, bulletinPolkadot)

  const bulletinDOT = bulletinPolkadot.custom.dot
  const polkadotDOT = assetHubPolkadot.custom.dot

  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to bulletinPolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: bulletinPolkadotClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(1, bulletinPolkadot.paraId!)),
    }
  })

  runXcmPalletHorizontal('bulletinPolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: bulletinPolkadotClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        bulletinDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubPolkadotClient.config.paraId!),
      ),
    }
  })
})
