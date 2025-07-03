import { describe, test } from 'vitest'

import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { treasurySpendForeignAssetTest } from '@e2e-test/shared/governance'

describe('polkadot & assetHub', async () => {
  const [polkadotClient, assetHubClient] = await setupNetworks(polkadot, assetHubPolkadot)

  test('Spend foreign asset from Relay treasury, make sure changes are reflected on AssetHub', async () => {
    await treasurySpendForeignAssetTest(polkadotClient, assetHubClient)
  })
})
