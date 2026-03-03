import { defaultAccounts, defaultAccountsSr25519 } from '@e2e-test/networks'
import { acala, assetHubPolkadot, hydration } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('acala & hydration', async () => {
  const [acalaClient, hydrationClient, assetHubPolkadotClient] = await setupNetworks(acala, hydration, assetHubPolkadot)

  runXtokenstHorizontal('acala transfer DOT to hydration', async () => {
    return {
      fromChain: acalaClient,
      toChain: hydrationClient,
      routeChain: assetHubPolkadotClient,
      toAccount: defaultAccountsSr25519.bob,
      fromBalance: query.tokens(acala.custom.dot),
      toBalance: query.tokens(hydration.custom.relayToken),
      tx: tx.xtokens.transfer(acala.custom.dot, 1e12, tx.xtokens.parachainV3(hydration.paraId!)),
    }
  })

  runXtokenstHorizontal('hydration transfer DOT to acala', async () => {
    return {
      fromChain: hydrationClient,
      toChain: acalaClient,
      routeChain: assetHubPolkadotClient,
      fromAccount: defaultAccountsSr25519.alice,
      toAccount: defaultAccounts.bob,
      fromBalance: query.tokens(hydration.custom.relayToken),
      toBalance: query.tokens(acala.custom.dot),
      tx: tx.xtokens.transfer(hydration.custom.relayToken, 1e12, tx.xtokens.parachainV3(acala.paraId!)),
    }
  })
})
