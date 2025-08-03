import { collectivesPolkadot, peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { authorizeUpgradeViaCollectives } from '@e2e-test/shared/upgrade.js'

import { describe, test } from 'vitest'

describe('polkadot & people & collectives', async () => {
  const [polkadotClient, peopleClient, collectivesClient] = await setupNetworks(
    polkadot,
    peoplePolkadot,
    collectivesPolkadot,
  )

  test('Relay authorizes People upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(polkadotClient, peopleClient, collectivesClient)
  })
})
