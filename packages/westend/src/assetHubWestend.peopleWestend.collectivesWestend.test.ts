import { describe, test } from 'vitest'

import { assetHubWestend, collectivesWestend, peopleWestend } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { authorizeUpgradeViaCollectives } from '@e2e-test/shared/upgrade.js'

describe('assetHubWestend & peopleWestend & collectivesWestend', async () => {
  const [ahClient, peopleClient, collectivesClient] = await setupNetworks(
    assetHubWestend,
    peopleWestend,
    collectivesWestend,
  )

  test('Asset Hub authorizes People upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(ahClient, peopleClient, collectivesClient)
  })
})
