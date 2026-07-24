import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { authorizeUpgradeViaCollectives } from '@e2e-test/shared/upgrade.js'

import { describe, test } from 'vitest'

describe('collectives & asset hub', async () => {
  const [assetHubPolkadotClient, collectivesClient] = await setupNetworks(assetHubPolkadot, collectivesPolkadot)

  test('Asset Hub authorizes upgrade for itself', async () => {
    await authorizeUpgradeViaCollectives(assetHubPolkadotClient, assetHubPolkadotClient, collectivesClient)
  })

  test('Asset Hub authorizes Collectives upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(assetHubPolkadotClient, collectivesClient, collectivesClient)
  })
})
