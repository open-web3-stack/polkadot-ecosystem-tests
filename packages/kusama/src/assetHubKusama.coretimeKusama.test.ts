import { defaultAccounts } from '@e2e-test/networks'
import { assetHubKusama, coretimeKusama } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  type ParaTestConfig,
  registerTestTree,
  setupNetworks,
} from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubKusama & coretimeKusama', async () => {
  const [assetHubKusamaClient, coretimeKusamaClient] = await setupNetworks(assetHubKusama, coretimeKusama)

  const coretimeKSM = coretimeKusama.custom.ksm
  const assetHubKSM = assetHubKusama.custom.ksm

  runXcmPalletHorizontal('assetHubKusama transfer KSM to coretimeKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: coretimeKusamaClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(assetHubKSM, 1e12, tx.xcmPallet.parachainV3(1, coretimeKusama.paraId!)),
    }
  })

  runXcmPalletHorizontal('coretimeKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: coretimeKusamaClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.balances,
      toBalance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.limitedTeleportAssets(
        coretimeKSM,
        1e12,
        tx.xcmPallet.parachainV3(1, assetHubKusamaClient.config.paraId!),
      ),
    }
  })
})

const testConfigForLocalScheduler: ParaTestConfig = {
  testSuiteName: 'assetHubKusama & coretimeKusama',
  addressEncoding: 2,
  blockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
}

registerTestTree(
  governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubKusama, coretimeKusama, testConfigForLocalScheduler),
)
