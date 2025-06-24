import { describe } from 'vitest'

import { defaultAccountsSr25519 } from '@e2e-test/networks'
import { assetHubPolkadot, integriteePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

describe('integriteePolkadot & assetHubPolkadot', async () => {
  const [assetHubPolkadotClient, integriteePolkadotClient] = await setupNetworks(assetHubPolkadot, integriteePolkadot)

  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to integriteePolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: integriteePolkadotClient,
      fromAccount: defaultAccountsSr25519.alice,
      toAccount: defaultAccountsSr25519.bob,
      fromBalance: query.balances,
      toBalance: query.assets(integriteePolkadot.custom.assetIdRelayNative),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        assetHubPolkadot.custom.dot,
        1e12,
        tx.xcmPallet.parachainV3(1, integriteePolkadot.paraId!),
      ),
    }
  })

  runXcmPalletHorizontal('integriteePolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: integriteePolkadotClient,
      toChain: assetHubPolkadotClient,
      fromAccount: defaultAccountsSr25519.alice,
      toAccount: defaultAccountsSr25519.bob,
      fromBalance: query.assets(integriteePolkadot.custom.assetIdRelayNative),
      toBalance: query.balances,
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(
        integriteePolkadot.custom.xcmRelayNative,
        // if its too much, it exhausts the sibling reserve. if its too little assets will be trapped because fees are higher than amount
        1e9,
        tx.xcmPallet.parachainV3(1, assetHubPolkadot.paraId!),
      ),
    }
  })
})
