import { assetHubPolkadot, collectivesPolkadot, polkadot } from '@e2e-test/networks/chains'
import { authorizeUpgradeViaCollectives, setupNetworks } from '@e2e-test/shared'

import { describe, test } from 'vitest'

describe('asset hub & polkadot & collectives', async () => {
  const [assetHubPolkadotClient, polkadotClient, collectivesClient] = await setupNetworks(
    assetHubPolkadot,
    polkadot,
    collectivesPolkadot,
  )

  test('Asset Hub authorizes Polkadot upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(assetHubPolkadotClient, polkadotClient, collectivesClient)
  })
})
