import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, coretimePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('assetHubPolkadot & coretimePolkadot', async () => {
  const [assetHubPolkadotClient, coretimePolkadotClient] = await setupNetworks(assetHubPolkadot, coretimePolkadot)

  const coretimeDOT = coretimePolkadot.custom.dot
  const polkadotDOT = assetHubPolkadot.custom.dot

  runXcmPalletDown('assetHubPolkadot transfer DOT to coretimePolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: coretimePolkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(1, coretimePolkadot.paraId!)),
    }
  })

  runXcmPalletUp('coretimePolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: coretimePolkadotClient,
      toChain: assetHubPolkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        coretimeDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubPolkadotClient.config.paraId!),
      ),
    }
  })
})
