import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, polkadot } from '@e2e-test/networks/chains'
import {
  governanceChainUpgradesOtherChainViaRootReferendumSuite,
  registerTestTree,
  setupNetworks,
  type TestConfig,
} from '@e2e-test/shared'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'

import { describe } from 'vitest'

describe('assetHubPolkadot & polkadot', async () => {
  const [polkadotClient, ahClient] = await setupNetworks(polkadot, assetHubPolkadot)

  runXcmPalletUp('Teleport DOT from Asset Hub to Polkadot', async () => {
    return {
      fromChain: ahClient,
      toChain: polkadotClient,
      balance: query.balances,
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
                                id: defaultAccounts.bob.addressRaw,
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
        { ref_time: 100_000_000_000n, proof_size: 1_000_000n },
      ),
    }
  })

  runXcmPalletDown('Teleport DOT from Polkadot to Asset Hub', async () => {
    return {
      fromChain: polkadotClient,
      toChain: ahClient,
      balance: query.balances,
      tx: tx.xcmPallet.executeXCM(
        {
          V4: [
            {
              WithdrawAsset: [
                {
                  id: {
                    parents: 0,
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
                  parents: 0,
                  interior: {
                    x1: [
                      {
                        Parachain: 1000,
                      },
                    ],
                  },
                },
                xcm: [
                  {
                    BuyExecution: {
                      fees: {
                        id: {
                          parents: 1,
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
                                id: defaultAccounts.bob.addressRaw,
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
        { ref_time: 100_000_000_000n, proof_size: 1_000_000n },
      ),
    }
  })
})

const testConfig: TestConfig = {
  testSuiteName: 'assetHubPolkadot & polkadot',
}

registerTestTree(governanceChainUpgradesOtherChainViaRootReferendumSuite(assetHubPolkadot, polkadot, testConfig))
