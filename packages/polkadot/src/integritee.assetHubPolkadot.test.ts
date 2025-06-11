import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, integriteePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

describe('integriteePolkadot & assetHubPolkadot', async () => {
  const [assetHubPolkadotClient, integriteePolkadotClient] = await setupNetworks(assetHubPolkadot, integriteePolkadot)

  const integriteeDOT = integriteePolkadot.custom.dot
  const polkadotDOT = assetHubPolkadot.custom.dot

  runXcmPalletDown('assetHubPolkadot transfer DOT to integriteePolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: integriteePolkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        polkadotDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, integriteePolkadot.paraId!),
      ),
    }
  })

  runXcmPalletUp('integriteePolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: integriteePolkadotClient,
      toChain: assetHubPolkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        integriteeDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubPolkadotClient.config.paraId!),
      ),
    }
  })
})
