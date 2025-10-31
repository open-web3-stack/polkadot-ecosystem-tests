import { collectivesPolkadot, polkadot } from '@e2e-test/networks/chains'
import {
  authorizeUpgradeViaCollectives,
  baseCollectivesChainE2ETests,
  governanceChainSelfUpgradeViaWhitelistedCallerReferendumSuite,
  registerTestTree,
  setupNetworks,
  type TestConfig,
} from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

import { describe, test } from 'vitest'

registerTestTree(
  baseCollectivesChainE2ETests(polkadot, collectivesPolkadot, { testSuiteName: 'collectives & polkadot' }),
)

describe('collectives & polkadot', async () => {
  const [polkadotClient, collectivesClient] = await setupNetworks(polkadot, collectivesPolkadot)

  const collectivesDOT = collectivesPolkadot.custom.dot
  const polkadotDOT = polkadot.custom.dot

  runXcmPalletDown('polkadot teleport DOT to collectivesPolkadot', async () => {
    return {
      fromChain: polkadotClient,
      toChain: collectivesClient,
      balance: query.balances,
      tx: tx.xcmPallet.teleportAssetsV3(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(0, collectivesPolkadot.paraId!)),
      totalIssuanceProvider: () => query.totalIssuance(polkadotClient),
    }
  })

  runXcmPalletUp('collectivesPolkadot teleport DOT to polkadot', async () => {
    return {
      fromChain: collectivesClient,
      toChain: polkadotClient,
      balance: query.balances,
      tx: tx.xcmPallet.teleportAssetsV3(collectivesDOT, 1e12, tx.xcmPallet.relaychainV4),
      totalIssuanceProvider: () => query.totalIssuance(polkadotClient),
    }
  })

  test('Relay authorizes upgrade for itself', async () => {
    await authorizeUpgradeViaCollectives(polkadotClient, polkadotClient, collectivesClient)
  })

  test('Relay authorizes Collectives upgrade via Collectives', async () => {
    await authorizeUpgradeViaCollectives(polkadotClient, collectivesClient, collectivesClient)
  })
})

const testConfig: TestConfig = {
  testSuiteName: 'collectives & polkadot',
  addressEncoding: 0,
  blockProvider: 'Local',
}

registerTestTree(
  governanceChainSelfUpgradeViaWhitelistedCallerReferendumSuite(polkadot, collectivesPolkadot, testConfig),
)
