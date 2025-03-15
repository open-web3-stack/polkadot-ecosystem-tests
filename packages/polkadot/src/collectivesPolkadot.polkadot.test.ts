import { collectivesPolkadot, polkadot } from '@e2e-test/networks/chains'

import { collectivesChainE2ETests, setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'
import { describe } from 'vitest'

collectivesChainE2ETests(polkadot, collectivesPolkadot, { testSuiteName: 'collectives & polkadot' })

describe('collectives & polkadot', async () => {
  const [polkadotClient, coretimeClient] = await setupNetworks(polkadot, collectivesPolkadot)

  const collectivesDOT = collectivesPolkadot.custom.dot
  const polkadotDOT = polkadot.custom.dot

  runXcmPalletDown('polkadot teleport DOT to collectivesPolkadot', async () => {
    return {
      fromChain: polkadotClient,
      toChain: coretimeClient,
      balance: query.balances,
      tx: tx.xcmPallet.teleportAssetsV3(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(0, collectivesPolkadot.paraId!)),
      totalIssuanceProvider: () => query.totalIssuance(polkadotClient),
    }
  })

  runXcmPalletUp('collectivesPolkadot teleport DOT to polkadot', async () => {
    return {
      fromChain: coretimeClient,
      toChain: polkadotClient,
      balance: query.balances,
      tx: tx.xcmPallet.teleportAssetsV3(collectivesDOT, 1e12, tx.xcmPallet.relaychainV4),
      totalIssuanceProvider: () => query.totalIssuance(polkadotClient),
    }
  })
})
