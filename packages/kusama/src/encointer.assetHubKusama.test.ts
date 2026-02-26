import { defaultAccountsSr25519 } from '@e2e-test/networks'
import { assetHubKusama, encointerKusama } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  setupNetworks,
  type TestConfig,
} from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('encointerKusama & assetHubKusama', async () => {
  const [assetHubKusamaClient, encointerKusamaClient] = await setupNetworks(assetHubKusama, encointerKusama)

  runXcmPalletHorizontal('assetHubKusama transfer KSM to encointerKusama', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: encointerKusamaClient,
      fromAccount: defaultAccountsSr25519.alice,
      toAccount: defaultAccountsSr25519.bob,
      fromBalance: query.balances,
      toBalance: query.balances,
      tx: tx.xcmPallet.limitedTeleportAssets(
        assetHubKusama.custom.ksm,
        1e11,
        tx.xcmPallet.parachainV3(1, encointerKusama.paraId!),
      ),
    }
  })

  runXcmPalletHorizontal('encointerKusama transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: encointerKusamaClient,
      toChain: assetHubKusamaClient,
      fromAccount: defaultAccountsSr25519.alice,
      toAccount: defaultAccountsSr25519.bob,
      fromBalance: query.balances,
      toBalance: query.balances,
      tx: tx.xcmPallet.limitedTeleportAssets(
        assetHubKusama.custom.ksm,
        1e11,
        tx.xcmPallet.parachainV3(1, assetHubKusama.paraId!),
      ),
    }
  })
})

const testConfig: TestConfig = {
  testSuiteName: 'encointerKusama & assetHubKusama',
}

registerTestTree(governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubKusama, encointerKusama, testConfig))
