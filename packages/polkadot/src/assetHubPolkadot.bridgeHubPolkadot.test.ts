import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, bridgeHubPolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubPolkadot & bridgeHubPolkadot', async () => {
  const [assetHubPolkadotClient, bridgeHubPolkadotClient] = await setupNetworks(assetHubPolkadot, bridgeHubPolkadot)

  const bridgeHubDOT = bridgeHubPolkadot.custom.dot
  const polkadotDOT = assetHubPolkadot.custom.dot

  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to bridgeHubPolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: bridgeHubPolkadotClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(1, bridgeHubPolkadot.paraId!)),
    }
  })

  runXcmPalletHorizontal('bridgeHubPolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: bridgeHubPolkadotClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        bridgeHubDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubPolkadotClient.config.paraId!),
      ),
    }
  })
})

// TODO: Uncomment Post-AHM on Polkadot

// const testConfigForLocalScheduler: ParaTestConfig = {
//   testSuiteName: 'assetHubPolkadot & bridgeHubPolkadot',
//   addressEncoding: 0,
//   blockProvider: 'NonLocal',
//   asyncBacking: 'Enabled',
// }

// registerTestTree(
//   governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubPolkadot, bridgeHubPolkadot, testConfigForLocalScheduler),
// )
