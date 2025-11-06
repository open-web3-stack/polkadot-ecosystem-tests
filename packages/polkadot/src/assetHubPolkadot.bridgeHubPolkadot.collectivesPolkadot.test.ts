import { assetHubPolkadot, bridgeHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { authorizeUpgradeViaCollectives } from '@e2e-test/shared/upgrade.js'

import { describe, test } from 'vitest'

describe('asset hub & bridgeHub & collectives', async () => {
  const [assetHubPolkadotClient, bridgeHubClient, collectivesClient] = await setupNetworks(
    assetHubPolkadot,
    bridgeHubPolkadot,
    collectivesPolkadot,
  )

  test('Asset Hub authorizes Bridge Hub upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(assetHubPolkadotClient, bridgeHubClient, collectivesClient)
  })
})
