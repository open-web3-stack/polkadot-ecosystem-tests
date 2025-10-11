import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Client, defaultAccounts } from '@e2e-test/networks'

import type { KeyringPair } from '@polkadot/keyring/types'

import { assert, it } from 'vitest'

import { check, checkEvents, checkSystemEvents } from '../helpers/index.js'
import type { GetBalance, GetTotalIssuance, Tx } from './types.js'

export const runXcmPalletDown = (
  name: string,
  setup: () => Promise<{
    fromChain: Client
    toChain: Client
    tx: Tx
    balance: GetBalance

    fromAccount?: KeyringPair
    toAccount?: KeyringPair
    precision?: number
    totalIssuanceProvider?: GetTotalIssuance
  }>,
  options: { only?: boolean; skip?: boolean } = {},
) => {
  const itfn = options.skip ? it.skip : options.only ? it.only : it
  itfn(
    name,
    async () => {
      const {
        fromChain,
        toChain,
        tx,
        balance,
        fromAccount = defaultAccounts.alice,
        toAccount = defaultAccounts.bob,
        precision = 3,
        totalIssuanceProvider = undefined,
      } = await setup()

      const totalIssuanceBefore = await totalIssuanceProvider?.()

      const tx0 = await sendTransaction(tx(fromChain, toAccount.addressRaw).signAsync(fromAccount))

      await fromChain.chain.newBlock()

      await check(fromChain.api.query.system.account(fromAccount.address))
        .redact({ number: precision })
        .toMatchSnapshot('balance on from chain')
      await checkEvents(tx0, 'polkadotXcm', 'xcmPallet').redact({ number: precision }).toMatchSnapshot('tx events')

      await toChain.chain.newBlock()

      await check(balance(toChain, toAccount.address))
        .redact({ number: precision })
        .toMatchSnapshot('balance on to chain')
      await checkSystemEvents(toChain, 'parachainSystem', 'dmpQueue', 'messageQueue').toMatchSnapshot(
        'to chain dmp events',
      )

      const totalIssuanceAfter = await totalIssuanceProvider?.()

      assert(
        !totalIssuanceProvider || totalIssuanceBefore.eq(totalIssuanceAfter),
        'Expecting total issuance to stay the same despite transfers',
      )
    },
    240000,
  )
}
