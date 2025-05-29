import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, bridgeHubPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('assetHubPolkadot & bridgeHubPolkadot', async () => {
  const [assetHubPolkadotClient, bridgeHubPolkadotClient] = await setupNetworks(assetHubPolkadot, bridgeHubPolkadot)

  const bridgeHubDOT = bridgeHubPolkadot.custom.dot
  const polkadotDOT = assetHubPolkadot.custom.dot

  runXcmPalletDown('assetHubPolkadot transfer DOT to bridgeHubPolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: bridgeHubPolkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(1, bridgeHubPolkadot.paraId!)),
    }
  })

  runXcmPalletUp('bridgeHubPolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: bridgeHubPolkadotClient,
      toChain: assetHubPolkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        bridgeHubDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubPolkadotClient.config.paraId!),
      ),
    }
  })
})
