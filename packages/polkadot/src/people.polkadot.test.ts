import { describe } from 'vitest'

import { defaultAccounts } from '@e2e-test/networks'
import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletDown, runXcmPalletUp } from '@e2e-test/shared/xcm'
import { setupNetworks } from '@e2e-test/shared'

describe('polkadot & peoplePolkadot', async () => {
  const [polkadotClient, peopleClient] = await setupNetworks(polkadot, peoplePolkadot)

  const peopleDOT = peoplePolkadot.custom.dot
  const polkadotDOT = polkadot.custom.dot

  runXcmPalletDown('polkadot transfer DOT to peoplePolkadot', async () => {
    return {
      fromChain: polkadotClient,
      toChain: peopleClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.teleportAssetsV3(polkadotDOT, 1e12, tx.xcmPallet.parachainV3(0, peoplePolkadot.paraId!)),
    }
  })

  runXcmPalletUp('peoplePolkadot transfer DOT to polkadot', async () => {
    return {
      fromChain: peopleClient,
      toChain: polkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.dave,
      tx: tx.xcmPallet.teleportAssetsV3(peopleDOT, 1e12, tx.xcmPallet.relaychainV4),
    }
  })

  runXcmPalletUp('Send dummy XCM', async () => {
    return {
      fromChain: peopleClient,
      toChain: polkadotClient,
      balance: query.balances,
      toAccount: defaultAccounts.charlie,
      tx: tx.xcmPallet.sendXCM(
        {
          V4: {
            parents: 1,
            interior: 'Here',
          },
        },
        {
          V4: [
            {
              WithdrawAsset: [
                {
                  id: {
                    parents: 0,
                    interior: 'Here',
                  },
                  fun: { Fungible: 1e12 },
                },
              ],
            },
            {
              BuyExecution: {
                fees: {
                  id: {
                    parents: 0,
                    interior: 'Here',
                  },
                  fun: {
                    fungible: 1_000_000_000n,
                  },
                },
                weight_limit: 'unlimited',
              },
            },
            {
              DepositAsset: {
                assets: {
                  wild: 'all',
                },
                beneficiary: {
                  parents: 0,
                  interior: {
                    x1: [
                      {
                        accountId32: {
                          id: '0x5e639b43e0052c47447dac87d6fd2b6ec50bdd4d0f614e4299c665249bbd09d9',
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
      ),
    }
  })
})
