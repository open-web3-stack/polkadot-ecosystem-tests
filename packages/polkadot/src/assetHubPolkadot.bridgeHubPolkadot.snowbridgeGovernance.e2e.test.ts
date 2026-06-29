import { assetHubPolkadot, bridgeHubPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks, snowbridgeHaltResumeTest, verifyReferencePreimageHashes } from '@e2e-test/shared'

import { describe, test } from 'vitest'

// Exercises the version-controlled Snowbridge halt/resume governance preimage against forked Asset Hub +
// Bridge Hub. See `@e2e-test/shared/snowbridge/governance` for the documented test bodies and the rationale
// behind each assertion.
describe('Snowbridge governance halt/resume preimage', async () => {
  const [assetHub, bridgeHub] = await setupNetworks(assetHubPolkadot, bridgeHubPolkadot)

  test('reference hashes match reference bytes', () => {
    verifyReferencePreimageHashes()
  })

  test('committed halt preimage halts the bridge; resume restores it', async () => {
    await snowbridgeHaltResumeTest(assetHub, bridgeHub)
  })
})
