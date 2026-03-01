import { assetHubKusama, shiden } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubKusama & shiden', async () => {
  const [assetHubKusamaClient, shidenClient] = await setupNetworks(assetHubKusama, shiden)

  const shidenKSM = shiden.custom.ksm
  const assetHubKSM = assetHubKusama.custom.ksm

  runXcmPalletHorizontal('assetHubKusama transfer KSM to shiden', async () => {
    return {
      fromChain: assetHubKusamaClient,
      toChain: shidenClient,
      fromBalance: query.balances,
      toBalance: query.assets(shidenKSM),
      tx: tx.xcmPallet.limitedReserveTransferAssetsV3(assetHubKSM, 1e12, tx.xcmPallet.parachainV3(1, shiden.paraId!)),
    }
  })

  runXtokenstHorizontal('shiden transfer KSM to assetHubKusama', async () => {
    return {
      fromChain: shidenClient,
      toChain: assetHubKusamaClient,
      fromBalance: query.assets(shidenKSM),
      toBalance: query.balances,
      tx: tx.xtokens.transfer(shidenKSM, 1e12, tx.xtokens.parachainV4(assetHubKusama.paraId!)),
    }
  })
})
