import { assetHubPolkadot, collectivesPolkadot, polkadot } from '@e2e-test/networks/chains'
import { authorizeUpgradeViaCollectives, setupNetworks } from '@e2e-test/shared'

import { describe, test } from 'vitest'

describe('polkadot & asset hub & collectives', async () => {
  const [polkadotClient, ahClient, collectivesClient] = await setupNetworks(
    polkadot,
    assetHubPolkadot,
    collectivesPolkadot,
  )

  test('Relay authorizes AssetHub upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(polkadotClient, ahClient, collectivesClient)
  })
})
