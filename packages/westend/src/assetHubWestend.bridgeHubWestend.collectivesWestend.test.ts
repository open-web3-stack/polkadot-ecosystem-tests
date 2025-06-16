import { describe, test } from 'vitest'

import { assetHubWestend, bridgeHubWestend, collectivesWestend } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { authorizeUpgradeViaCollectives } from '@e2e-test/shared/upgrade.js'

describe('assetHubWestend & bridgeHubWestend & collectivesWestend', async () => {
  const [ahClient, bridgeHubClient, collectivesClient] = await setupNetworks(
    assetHubWestend,
    bridgeHubWestend,
    collectivesWestend,
  )

  test('Asset Hub authorizes People upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(ahClient, bridgeHubClient, collectivesClient)
  })
})
