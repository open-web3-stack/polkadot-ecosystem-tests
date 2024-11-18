import { describe } from 'vitest'

import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import { defaultAccounts } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('asset hub & polkadot', async () => {
  const [polkadotClient, ahClient] = await setupNetworks(polkadot, assetHubPolkadot)

  runXcmPalletUp('[XCM] Withdraw, Teleport, Receive, Deposit', async () => {
    return {
      fromChain: ahClient,
      toChain: polkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.charlie,
      tx: tx.xcmPallet.executeXCM(
        {
          V4: [
            {
              WithdrawAsset: [
                {
                  id: {
                    parents: 1,
                    interior: 'Here',
                  },
                  fun: { Fungible: 7e12 },
                },
              ],
            },
            {
              SetFeesMode: {
                jit_withdraw: true,
              },
            },
            {
              InitiateTeleport: {
                assets: {
                  wild: 'All',
                },
                dest: {
                  parents: 1,
                  interior: 'Here',
                },
                xcm: [
                  {
                    BuyExecution: {
                      fees: {
                        id: {
                          parents: 0,
                          interior: 'Here',
                        },
                        fun: {
                          fungible: 500_000_000_000n,
                        },
                      },
                      weight_limit: 'unlimited',
                    },
                  },
                  {
                    DepositAsset: {
                      assets: {
                        wild: {
                          allCounted: 1,
                        },
                      },
                      beneficiary: {
                        parents: 0,
                        interior: {
                          x1: [
                            {
                              accountId32: {
                                id: defaultAccounts.charlie.addressRaw,
                                network: null,
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
        { ref_time: 55_791_617_000n, proof_size: 364_593n },
      ),
    }
  })
})
