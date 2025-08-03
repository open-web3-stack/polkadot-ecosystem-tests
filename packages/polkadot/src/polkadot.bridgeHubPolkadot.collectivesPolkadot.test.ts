import { bridgeHubPolkadot, collectivesPolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { authorizeUpgradeViaCollectives } from '@e2e-test/shared/upgrade.js'

import { describe, test } from 'vitest'

describe('polkadot & bridgeHub & collectives', async () => {
  const [polkadotClient, bridgeHubClient, collectivesClient] = await setupNetworks(
    polkadot,
    bridgeHubPolkadot,
    collectivesPolkadot,
  )

  test('Relay authorizes Bridge Hub upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(polkadotClient, bridgeHubClient, collectivesClient)
  })
})
