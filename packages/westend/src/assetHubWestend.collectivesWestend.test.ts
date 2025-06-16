import { defaultAccounts } from '@e2e-test/networks'
import { assetHubWestend, collectivesWestend } from '@e2e-test/networks/chains'
import { collectivesChainE2ETests } from '@e2e-test/shared'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { authorizeUpgradeViaCollectives } from '@e2e-test/shared/upgrade.js'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'
import { describe, test } from 'vitest'

collectivesChainE2ETests(assetHubWestend, collectivesWestend, {
  testSuiteName: 'collectives westend & asset hub westend',
})

describe('assetHubWestend & collectivesWestend', async () => {
  const [assetHubWestendClient, collectivesClient] = await setupNetworks(assetHubWestend, collectivesWestend)

  const collectivesWND = collectivesWestend.custom.wnd
  const westendWND = assetHubWestend.custom.wnd

  runXcmPalletDown('assetHubWestend transfer WND to collectivesWestend', async () => {
    return {
      fromChain: assetHubWestendClient,
      toChain: collectivesClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(westendWND, 1e12, tx.xcmPallet.parachainV3(1, collectivesWestend.paraId!)),
    }
  })

  runXcmPalletUp('collectivesWestend transfer WND to assetHubWestend', async () => {
    return {
      fromChain: collectivesClient,
      toChain: assetHubWestendClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        collectivesWND,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubWestendClient.config.paraId!),
      ),
    }
  })

  test('Asset Hub authorizes People upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(assetHubWestendClient, assetHubWestendClient, collectivesClient)
  })
})
