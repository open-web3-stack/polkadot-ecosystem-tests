import { afterAll, describe } from 'vitest'
import { connectParachains, connectVertical } from '@acala-network/chopsticks'
import { defaultAccount } from '@e2e-test/shared'

import { acala, moonbeam, polkadot } from '@e2e-test/networks/chains'
import { createNetwork } from '@e2e-test/networks'
import { query, tx } from '@e2e-test/shared/api'
import { runXtokenstHorizontal } from '@e2e-test/shared/xcm'

// acala <=> moonbeam
describe(`'acala' <-> 'moonbeam' xcm transfer 'DOT'`, async () => {
  const [acalaClient, moonbeamClient, polkadotClient] = await Promise.all([
    createNetwork(acala),
    createNetwork(moonbeam),
    createNetwork(polkadot),
  ])

  await connectVertical(polkadotClient.chain, acalaClient.chain)
  await connectVertical(polkadotClient.chain, moonbeamClient.chain)
  await connectParachains([acalaClient.chain, moonbeamClient.chain])

  const acalaDot = acalaClient.config.custom!.dot
  const moonbeamDot = moonbeamClient.config.custom!.dot

  afterAll(async () => {
    await acalaClient.teardown()
    await moonbeamClient.teardown()
    await polkadotClient.teardown()
  })

  runXtokenstHorizontal(`'acala' -> 'moonbeam' DOT`, async () => {
    return {
      fromChain: acalaClient,
      fromBalance: query.tokens(acalaDot),
      fromAccount: defaultAccount.alice,

      toChain: moonbeamClient,
      toBalance: query.assets(moonbeamDot),
      toAccount: defaultAccount.alith,

      routeChain: polkadotClient,
      isCheckUmp: true,

      tx: tx.xtokens.transfer(acalaDot, 1e12, tx.xtokens.parachainAccountId20V3(moonbeamClient.config.paraId!)),
    }
  })

  runXtokenstHorizontal(`'moonbeam' -> 'acala' DOT`, async () => {
    await moonbeamClient.dev.setStorage({
      Assets: {
        account: [[[moonbeamDot, defaultAccount.alith.address], { balance: 10e12 }]],
      },
    })

    return {
      fromChain: moonbeamClient,
      fromBalance: query.assets(moonbeamDot),
      fromAccount: defaultAccount.alith,

      toChain: acalaClient,
      toBalance: query.tokens(acalaDot),
      toAccount: defaultAccount.alice,

      routeChain: polkadotClient,
      isCheckUmp: true,

      tx: tx.xtokens.transfer({ ForeignAsset: moonbeamDot }, 1e12, tx.xtokens.parachainV3(acalaClient.config.paraId!)),
    }
  })
})
