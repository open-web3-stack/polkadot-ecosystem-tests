import type { Client } from '@e2e-test/networks'
import { defaultAccounts, defaultAccountsSr25519 } from '@e2e-test/networks'
import { acala, assetHubPolkadot, hydration } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { beforeAll, describe } from 'vitest'

// Skipped: Acala fork setup intermittently times out (RpcError -32603), flaking CI. See #660.
// Network setup lives in beforeAll so that describe.skip actually prevents it from running (an
// async describe factory would run at collection time regardless of skip).
describe.skip('acala & hydration', () => {
  let acalaClient: Client
  let hydrationClient: Client
  let assetHubPolkadotClient: Client

  beforeAll(async () => {
    ;[acalaClient, hydrationClient, assetHubPolkadotClient] = await setupNetworks(acala, hydration, assetHubPolkadot)
  })

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
