import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, coretimePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubPolkadot & coretimePolkadot', async () => {
  const [assetHubPolkadotClient, coretimePolkadotClient] = await setupNetworks(assetHubPolkadot, coretimePolkadot)

  const coretimeDOT = coretimePolkadot.custom.dot
  const polkadotDOT = assetHubPolkadot.custom.dot

  runXcmPalletHorizontal('assetHubPolkadot transfer DOT to coretimePolkadot', async () => {
    return {
      fromChain: assetHubPolkadotClient,
      toChain: coretimePolkadotClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(1, coretimePolkadot.paraId!)),
    }
  })

  runXcmPalletHorizontal('coretimePolkadot transfer DOT to assetHubPolkadot', async () => {
    return {
      fromChain: coretimePolkadotClient,
      toChain: assetHubPolkadotClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        coretimeDOT,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubPolkadotClient.config.paraId!),
      ),
    }
  })
})

// TODO: Uncomment Post-AHM on Polkadot

// const testConfigForLocalScheduler: ParaTestConfig = {
//   testSuiteName: 'assetHubPolkadot & coretimePolkadot',
//   addressEncoding: 0,
//   blockProvider: 'NonLocal',
//   asyncBacking: 'Enabled',
// }

// registerTestTree(
//   governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubPolkadot, coretimePolkadot, testConfigForLocalScheduler),
// )
