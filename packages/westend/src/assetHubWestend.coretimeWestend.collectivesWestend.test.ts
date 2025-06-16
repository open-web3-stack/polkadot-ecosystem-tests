import { describe, test } from 'vitest'

import { assetHubWestend, collectivesWestend, coretimeWestend } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { authorizeUpgradeViaCollectives } from '@e2e-test/shared/upgrade.js'

describe('assetHubWestend & coretimeWestend & collectivesWestend', async () => {
  const [ahClient, cortetimeClient, collectivesClient] = await setupNetworks(
    assetHubWestend,
    coretimeWestend,
    collectivesWestend,
  )

  test('Asset Hub authorizes People upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(ahClient, cortetimeClient, collectivesClient)
  })
})
