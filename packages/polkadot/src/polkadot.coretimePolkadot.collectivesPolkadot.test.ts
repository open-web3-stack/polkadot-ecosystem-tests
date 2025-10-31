import { collectivesPolkadot, coretimePolkadot, polkadot } from '@e2e-test/networks/chains'
import { authorizeUpgradeViaCollectives, setupNetworks } from '@e2e-test/shared'

import { describe, test } from 'vitest'

describe('polkadot & coretime & collectives', async () => {
  const [polkadotClient, coretimeClient, collectivesClient] = await setupNetworks(
    polkadot,
    coretimePolkadot,
    collectivesPolkadot,
  )

  test('Relay authorizes Coretime upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(polkadotClient, coretimeClient, collectivesClient)
  })
})
