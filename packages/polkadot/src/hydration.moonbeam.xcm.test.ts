import type { Client } from '@e2e-test/networks'
import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, hydration, moonbeam } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal, runXtokenstHorizontal } from '@e2e-test/shared/xcm'

import { beforeAll, describe } from 'vitest'

// Network setup must happen inside `beforeAll`, not in the `describe` body.
// Vitest executes `describe` bodies at collection time even for skipped
// suites, so a top-level `await setupNetworks(...)` here would hang test
// collection whenever the Moonbeam endpoint is unreachable.
describe.skip('hydration & moonbeam', () => {
  // TODO: until we figured out how to query balances on Moonbeam again
  let hydrationClient: Client
  let moonbeamClient: Client
  let assetHubPolkadotClient: Client

  beforeAll(async () => {
    ;[hydrationClient, moonbeamClient, assetHubPolkadotClient] = await setupNetworks(
      hydration,
      moonbeam,
      assetHubPolkadot,
    )
  })

  const hydrationDot = hydration.custom.relayToken
  const moonbeamDot = moonbeam.custom.dot
  const glmr = hydration.custom.glmr

  runXtokenstHorizontal('hydration transfer DOT to moonbeam', async () => {
    return {
      fromChain: hydrationClient,
      fromBalance: query.tokens(hydrationDot),
      fromAccount: defaultAccounts.alice,

      toChain: moonbeamClient,
      toBalance: query.assets(moonbeamDot),
      toAccount: defaultAccounts.alith,

      routeChain: assetHubPolkadotClient,

      tx: tx.xtokens.transfer(hydrationDot, 2e12, tx.xtokens.parachainAccountId20V3(moonbeam.paraId!)),
    }
  })

  runXcmPalletHorizontal('moonbeam transfer DOT to hydration', async () => {
    await moonbeamClient.dev.setStorage({
      Assets: {
        account: [[[moonbeamDot, defaultAccounts.alith.address], { balance: 10e12 }]],
      },
    })

    return {
      fromChain: moonbeamClient,
      fromBalance: query.assets(moonbeamDot),
      fromAccount: defaultAccounts.alith,

      toChain: hydrationClient,
      toBalance: query.tokens(hydrationDot),
      toAccount: defaultAccounts.bob,

      routeChain: assetHubPolkadotClient,

      tx: tx.xcmPallet.transferAssetsV3(moonbeam.custom.xcmDot, 2e10, tx.xcmPallet.parachainV3(1, hydration.paraId!)),
    }
  })

  runXtokenstHorizontal('hydration transfer GLMR to moonbeam', async () => {
    await hydrationClient.dev.setStorage({
      Tokens: {
        Accounts: [[[defaultAccounts.alice.address, glmr], { free: '50000000000000000000000' }]],
      },
    })

    return {
      fromChain: hydrationClient,
      fromBalance: query.tokens(glmr),
      fromAccount: defaultAccounts.alice,
      toChain: moonbeamClient,
      toBalance: query.balances,
      toAccount: defaultAccounts.baltathar,

      tx: tx.xtokens.transfer(glmr, '200000000000000000000', tx.xtokens.parachainAccountId20V3(moonbeam.paraId!)),
    }
  })
})
