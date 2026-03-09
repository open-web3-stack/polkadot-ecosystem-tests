import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubPolkadot & collectivesPolkadot', async () => {
  const [assetHubPolkadotClient, collectivesPolkadotClient] = await setupNetworks(assetHubPolkadot, collectivesPolkadot)

  const collectivesDOT = collectivesPolkadot.custom.dot
  const polkadotDOT = assetHubPolkadot.custom.dot

  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to collectivesPolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: collectivesPolkadotClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        polkadotDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, collectivesPolkadot.paraId!),
      ),
    }
  })

  runXcmPalletHorizontal('collectivesPolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: collectivesPolkadotClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        collectivesDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubPolkadotClient.config.paraId!),
      ),
    }
  })
})
