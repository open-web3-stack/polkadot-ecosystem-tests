import { type KeyringPair } from '@polkadot/keyring/types'
import { it } from 'vitest'
import { sendTransaction } from '@acala-network/chopsticks-testing'

import { Client } from '@e2e-test/networks'
import { GetBalance, Tx } from './types.js'
import { check, checkEvents, checkSystemEvents, checkUmp } from '../helpers/index.js'
import { defaultAccount } from '../index.js'

export const runXtokensUp = (
  name: string,
  setup: () => Promise<{
    fromChain: Client
    toChain: Client
    tx: Tx
    balance: GetBalance

    fromAccount?: KeyringPair
    toAccount?: KeyringPair
    precision?: number
  }>,
  options: { only?: boolean } = {},
) => {
  const itfn = options.only ? it.only : it
  itfn(
    name,
    async () => {
      const {
        fromChain,
        toChain,
        tx,
        balance,
        fromAccount = defaultAccount.alice,
        toAccount = defaultAccount.bob,
        precision = 3,
      } = await setup()
      const tx0 = await sendTransaction(tx(fromChain, toAccount.addressRaw).signAsync(fromAccount))

      await fromChain.chain.newBlock()

      await check(balance(fromChain, fromAccount.address))
        .redact({ number: precision })
        .toMatchSnapshot('balance on from chain')
      await checkEvents(tx0, 'xTokens').redact({ number: precision }).toMatchSnapshot('tx events')
      await checkUmp(fromChain).toMatchSnapshot('from chain ump messages')

      await toChain.chain.newBlock()

      await check(toChain.api.query.system.account(toAccount.address))
        .redact({ number: precision })
        .toMatchSnapshot('balance on to chain')
      await checkSystemEvents(toChain, 'ump', 'messageQueue').toMatchSnapshot('to chain ump events')
    },
    240000,
  )
}
