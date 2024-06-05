import { afterAll, describe } from 'vitest'
import { connectParachains } from '@acala-network/chopsticks'

import { basilisk, karura } from '@e2e-test/networks/chains'
import { createNetwork } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXcmPalletHorizontal } from '@e2e-test/shared/xcm'

// karura <=> basilisk
describe(`'karura' <-> 'basilisk' xcm transfer 'DAI'`, async () => {
  const [karuraClient, basiliskClient] = await Promise.all([createNetwork(karura), createNetwork(basilisk)])

  await connectParachains([karuraClient.chain, basiliskClient.chain])

  const karuraDai = karuraClient.config.custom!.dai.Erc20
  const basiliskDai = basiliskClient.config.custom!.dai

  afterAll(async () => {
    await karuraClient.teardown()
    await basiliskClient.teardown()
  })

  runXcmPalletHorizontal(`'karura' -> 'basilisk' xcm transfer 'DAI'`, async () => {
    await karuraClient.dev.setStorage({
      Evm: {
        accountStorages: [
          [
            [
              karuraDai,
              '0x2aef47e62c966f0695d5af370ddc1bc7c56902063eee60853e2872fc0ff4f88c', // balanceOf(Alice)
            ],
            '0x0000000000000000000000000000000000000000000000056bc75e2d63100000', // 1e20
          ],
        ],
      },
    })

    return {
      fromChain: karuraClient,
      toChain: basiliskClient,
      fromBalance: query.evm(karuraDai, '0x2aef47e62c966f0695d5af370ddc1bc7c56902063eee60853e2872fc0ff4f88c'),
      toBalance: query.tokens(basiliskDai),
      tx: tx.xtokens.transfer(karura.dai, 10n ** 18n, tx.xtokens.parachainV3(basiliskClient.config.paraId!)),
    }
  })

  // TODO: restore this once Basilisk fixed the asset mapping issue
  //   runXcmPalletHorizontal(`'basilisk' -> 'karura' xcm transfer 'DAI'`, async () => {
  //     await basiliskClient.dev.setStorage({
  //       Tokens: {
  //         accounts: [[[defaultAccount.alice.address, basiliskDai], { free: 10n * 10n ** 18n }]],
  //       },
  //     })

  //     return {
  //       fromChain: basiliskClient,
  //       toChain: karuraClient,
  //       fromBalance: query.tokens(basiliskDai),
  //       toBalance: query.evm(karuraDai, '0x2aef47e62c966f0695d5af370ddc1bc7c56902063eee60853e2872fc0ff4f88c'),
  //       tx: tx.xtokens.transfer(basilisk.dai, 10n ** 18n, tx.xtokens.parachainV3(karuraClient.config.paraId!)),
  //     }
  //   })
})
